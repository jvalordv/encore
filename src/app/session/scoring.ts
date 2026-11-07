/**
 * Learning mode in the session: the practice mode (karaoke or learning), the
 * scoring style (Strict or Open), the melody and the song's key scored
 * against, the phrases marked free, the live grade of each frame the lane
 * draws, and the report a finished take gets. It owns the lane's end of the
 * frame bus: every frame is announced to the lane here, with its grade in
 * learning mode and with none in karaoke mode, which is what keeps karaoke mode
 * free of hit colours. Nothing in karaoke mode is computed, stored or shown: no
 * melody is scored, no band is drawn and a take gets no report.
 *
 * Strict needs the original singer, so on a karaoke track (a result with the
 * Karaoke badge, or a track the service found no singer in) and on a song with
 * no melody it has nothing to compare with; the panel says so before the take
 * (src/app/learning.ts), and the take is measured on the voice alone (the lane
 * coloured like a tuner, the card's "Your voice"). Open scores such a song as
 * all freestyle against the song's key, and gives the voice section too.
 */
import { sameSpan, withSpan } from '../../analysis/free-phrases';
import type { Span } from '../../analysis/free-phrases';
import { scoreTake, StyledScorer } from '../../analysis/open-score';
import type { PitchFrame } from '../../analysis/pitch';
import type { ScoreReference, ScoringStyle, TakeReport } from '../../analysis/score';
import type { KeyMap } from '../../service/types';
import { loadFreePhrases, saveFreePhrases } from '../free-store';
import { initialKey } from '../key-state';
import type { KeyState } from '../key-state';
import { isKaraokeTrack } from '../learning';
import { filterForMode } from '../search';
import type { PracticeMode } from '../settings';
import type { SessionCore } from './core';

/** Scores the singing against the melody and the key, in learning mode only. */
export class ScoringController {
  private reference: ScoreReference | null = null;
  private key: KeyMap | null = null;
  private free: Array<[number, number]> = [];
  private readonly live: StyledScorer;
  private songHash: string | null = null;

  constructor(private readonly core: SessionCore) {
    this.live = new StyledScorer({
      scoring: () => this.isScoring(),
      reference: () => this.activeReference(),
      style: () => core.current.scoring,
      octaveInvariant: () => core.current.octaveInvariant,
      key: () => this.keyMap(),
      freeSpans: () => this.free,
    });
    // After the take recorder's subscriber, as the take is recorded before the
    // lane draws the frame.
    this.live.attach(core.bus, ({ frame, gated }, grade) => {
      // While a take replays, its own trace owns the lane.
      if (core.store.state.playingTakeId !== null) return;
      // A frame under the level gate is a gap, not jitter.
      if (gated) {
        core.lane?.pushFrame({ t: frame.t, f0: 0, clarity: frame.clarity });
        return;
      }
      const drawn = { t: frame.t, f0: frame.f0, clarity: frame.clarity };
      core.lane?.pushFrame(grade === null ? drawn : { ...drawn, grade });
    });
    // A card, and the phrases marked free, belong to the song they were made for.
    core.store.subscribe((state, changed) => {
      if (!changed.has('song')) return;
      const hash = state.song?.hash ?? null;
      if (hash === this.songHash) return;
      this.songHash = hash;
      if (state.reportTakeId !== null) core.store.patch({ reportTakeId: null });
      this.free = hash === null ? [] : loadFreePhrases(core.settingsStore, hash);
      this.publishFree();
    });
  }

  /** The melody to score against; null when the song has none. */
  setReference(reference: ScoreReference | null): void {
    this.reference = reference;
  }

  /** The song's key map, moved by the key shift, for the note guide; null without one. */
  keyMap(): KeyMap | null {
    return this.core.keys.key(this.key);
  }

  /** The song's key to judge freestyle against, with what the panel says of it. */
  setKey(key: KeyMap | null, state: KeyState = initialKey()): void {
    this.key = key;
    this.core.store.patch({ key: state });
  }

  /** Gives a lane attached after the phrases were read the bands and the click it missed. */
  syncLane(): void {
    const { lane } = this.core;
    if (!lane) return;
    lane.setPhraseClick((span) => this.togglePhrase(span));
    lane.setFreePhrases(this.core.current.mode === 'learning' ? this.free : []);
  }

  /** Switches between karaoke and learning mode, remembers it, and retunes the search. */
  setMode(mode: PracticeMode): void {
    const { core } = this;
    if (core.current.mode === mode && core.store.state.mode === mode) return;
    core.current.mode = mode;
    core.persist();
    core.store.patch({ mode });
    core.search.setFilter(filterForMode(mode));
    this.syncLane();
    this.clearOldGrades();
  }

  /** Switches between the Strict and Open styles and remembers it. */
  setScoring(style: ScoringStyle): void {
    const { core } = this;
    if (core.current.scoring === style && core.store.state.scoring === style) return;
    core.current.scoring = style;
    core.persist();
    core.store.patch({ scoring: style });
    this.clearOldGrades();
  }

  /** Opens a take's report card, or closes the card with null. */
  showReport(takeId: string | null): void {
    this.core.store.patch({ reportTakeId: takeId });
  }

  /**
   * The report for a take just recorded, or null when none is due: karaoke
   * mode or the Mic check. A song with no melody (or a karaoke track) gets the
   * voice section alone.
   */
  reportFor(frames: readonly PitchFrame[]): TakeReport | null {
    return this.isScoring() ? this.scoreIn(frames, this.core.current.scoring) : null;
  }

  /** Marks or unmarks the phrase under a Shift+click; only while learning. */
  togglePhrase(span: Span): void {
    if (this.core.current.mode !== 'learning' || this.reference === null) return;
    this.applyFree(span, undefined);
  }

  /**
   * Marks or unmarks a phrase from the report card and re-scores that take from
   * its stored frames, in the style it was scored in, so the card matches.
   */
  async setPhraseFree(takeId: string, span: Span, free: boolean): Promise<void> {
    const { core } = this;
    this.applyFree(span, free);
    const takes = await core.takesReady;
    const take = await takes.get(takeId);
    if (!take?.report || take.songHash !== core.store.state.song?.hash) return;
    const report = this.scoreIn(take.frames, take.report.style ?? 'strict', take.shiftSemitones ?? 0);
    await takes.setReport(takeId, report);
    await core.takes.refreshTakes();
  }

  /** True while the singing is being measured: learning mode, whatever the song. */
  private isScoring(): boolean {
    const { core } = this;
    // The Mic check measures the mic and never grades the singing.
    if (core.micCheck.active) return false;
    return core.current.mode === 'learning';
  }

  /** The melody, unless the song is a karaoke track, which has no original singer. */
  private activeReference(shift?: number): ScoreReference | null {
    const ref = isKaraokeTrack(this.core.store.state) ? null : this.reference;
    return this.core.keys.score(ref, shift);
  }

  /** Scores frames sung with the song moved by `shift` (the shift in force when left out). */
  private scoreIn(frames: readonly PitchFrame[], style: ScoringStyle, shift?: number): TakeReport {
    return scoreTake(frames, this.activeReference(shift), {
      style,
      octaveInvariant: this.core.current.octaveInvariant,
      key: this.core.keys.key(this.key, shift),
      freeSpans: this.free,
    });
  }

  private applyFree(span: Span, free: boolean | undefined): void {
    const hash = this.core.store.state.song?.hash;
    if (hash === undefined) return;
    const next = withSpan(this.free, span, free);
    if (next.length === this.free.length && next.every((s, i) => sameSpan(s, this.free[i]))) return;
    this.free = next;
    saveFreePhrases(this.core.settingsStore, hash, next);
    this.publishFree();
  }

  private publishFree(): void {
    this.core.store.patch({ freePhrases: [...this.free] });
    this.syncLane();
  }

  /** Frames already on the lane carry the old setting's grades (or lack them). */
  private clearOldGrades(): void {
    const { core } = this;
    if (core.store.state.playingTakeId !== null) core.takes.resyncReplay();
    else core.lane?.clearFrames();
  }
}
