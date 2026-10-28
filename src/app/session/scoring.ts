/**
 * Learning mode in the session: the practice mode (karaoke or learning), the
 * melody scored against, the live grade of each frame the lane draws, and the
 * report a finished take gets. It owns the lane's end of the frame bus: every
 * frame is announced to the lane here, with its grade in learning mode and
 * with none in karaoke mode, which is what keeps karaoke mode free of hit
 * colours. Nothing in karaoke mode is computed, stored or shown: no melody is
 * scored and a take gets no report.
 *
 * Scoring needs the original singer, so a karaoke track (a result with the
 * Karaoke badge, or a track the service found no singer in) is not scored
 * either; the panel says so before the take (src/app/learning.ts).
 */
import type { PitchFrame } from '../../analysis/pitch';
import { LiveScorer, reportTake } from '../../analysis/score';
import type { ScoreReference, TakeReport } from '../../analysis/score';
import { isKaraokeTrack } from '../learning';
import { filterForMode } from '../search';
import type { PracticeMode } from '../settings';
import type { SessionCore } from './core';

/** Scores the singing against the melody, in learning mode only. */
export class ScoringController {
  private reference: ScoreReference | null = null;
  private readonly live: LiveScorer;
  private songHash: string | null = null;

  constructor(private readonly core: SessionCore) {
    this.live = new LiveScorer({
      reference: () => this.activeReference(),
      octaveInvariant: () => core.current.octaveInvariant,
    });
    // After the take recorder's subscriber, as the take is recorded before the
    // lane draws the frame.
    this.live.attach(core.bus, ({ frame }, grade) => {
      // While a take replays, its own trace owns the lane.
      if (core.store.state.playingTakeId !== null) return;
      const drawn = { t: frame.t, f0: frame.f0, clarity: frame.clarity };
      core.lane?.pushFrame(grade === null ? drawn : { ...drawn, grade });
    });
    // A card belongs to the song it was sung over.
    core.store.subscribe((state, changed) => {
      if (!changed.has('song')) return;
      const hash = state.song?.hash ?? null;
      if (hash !== this.songHash && state.reportTakeId !== null) core.store.patch({ reportTakeId: null });
      this.songHash = hash;
    });
  }

  /** The melody to score against; null when the song has none. */
  setReference(reference: ScoreReference | null): void {
    this.reference = reference;
  }

  /** Switches between karaoke and learning mode, remembers it, and retunes the search. */
  setMode(mode: PracticeMode): void {
    const { core } = this;
    if (core.current.mode === mode && core.store.state.mode === mode) return;
    core.current.mode = mode;
    core.persist();
    core.store.patch({ mode });
    core.search.setFilter(filterForMode(mode));
    // Frames already on the lane carry the old mode's grades (or lack them).
    if (core.store.state.playingTakeId !== null) core.takes.resyncReplay();
    else core.lane?.clearFrames();
  }

  /** Opens a take's report card, or closes the card with null. */
  showReport(takeId: string | null): void {
    this.core.store.patch({ reportTakeId: takeId });
  }

  /**
   * The report for a take just recorded, or null when none is due: karaoke
   * mode, no melody, or a karaoke track.
   */
  reportFor(frames: readonly PitchFrame[]): TakeReport | null {
    const reference = this.activeReference();
    return reference === null ? null : reportTake(frames, reference, this.core.current.octaveInvariant);
  }

  /** The melody, but only while learning mode is on and the song has a singer. */
  private activeReference(): ScoreReference | null {
    const { core } = this;
    if (core.current.mode !== 'learning' || this.reference === null) return null;
    return isKaraokeTrack(core.store.state) ? null : this.reference;
  }
}
