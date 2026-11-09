/**
 * Range and key in the session (W6b). Holds the one derived "transposed
 * reference" seam: the song's own melody, key map and scoring reference stay
 * as the service gave them, and every consumer asks here for the version
 * moved by the shift in force (`lane`, `score`, `key`). The shift is chosen
 * per song and kept (src/app/key-shift.ts); it is applied to playback through
 * the Player's pitch shifter, and to the lane, keyboard, scoring, note guide
 * and MIDI export (and the backing notes, W0g) by the same number, so they cannot disagree. A song whose
 * sound cannot be moved (YouTube's own player) is not moved at all: the
 * suggestion shows, nothing else changes. Also holds the singer's range, read
 * from the learning takes' voice sections, which the lane draws on its
 * keyboard in both modes; it judges nothing.
 */
import {
  MAX_SHIFT,
  clampShift,
  estimateRange,
  melodyRange,
  suggestShift,
  transposeKey,
  transposeLane,
  transposeScore,
} from '../../analysis/key-shift';
import type { MidiSpan } from '../../analysis/key-shift';
import type { ScoreReference } from '../../analysis/score';
import { transposeBacking } from '../../render/lane-backing';
import type { LaneBacking } from '../../render/lane-backing';
import type { LaneReference } from '../../render/lane-geometry';
import type { KeyMap } from '../../service/types';
import { loadShift, saveShift } from '../key-shift';
import { takesOfProfile } from '../profiles';
import type { SessionCore } from './core';

/** A transform of one input at one shift, remembered so repeats cost nothing. */
class Memo<I extends object, O> {
  private input: I | null = null;
  private shift = 0;
  private output: O | null = null;

  constructor(private readonly make: (input: I, shift: number) => O) {}

  get(input: I, shift: number): O {
    if (this.input !== input || this.shift !== shift || this.output === null) {
      this.input = input;
      this.shift = shift;
      this.output = this.make(input, shift);
    }
    return this.output;
  }
}

/** Owns the key shift, its persistence and the singer's range. */
export class KeyController {
  private songHash: string | null = null;
  // What the singer chose for this song, kept even while it cannot be applied.
  private wanted = 0;
  // A take's own shift while it replays; the song's choice returns after.
  private loan: number | null = null;
  private applied = 0;
  private band: (MidiSpan & { takes: number }) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly laneMemo = new Memo(transposeLane);
  private readonly scoreMemo = new Memo(transposeScore);
  private readonly keyMemo = new Memo(transposeKey);
  private readonly backingMemo = new Memo(transposeBacking);

  constructor(private readonly core: SessionCore) {
    core.store.subscribe((state, changed) => {
      if (!changed.has('song') && !changed.has('clock')) return;
      const hash = state.song?.hash ?? null;
      if (hash !== this.songHash) {
        this.songHash = hash;
        this.wanted = hash === null ? 0 : loadShift(core.settingsStore, hash);
      }
      this.apply();
    });
    this.refresh();
    void this.refreshRange();
  }

  /** The shift in force, in semitones. */
  get shift(): number {
    return this.applied;
  }

  /** Seconds the pitch shifter delays the sound by right now; 0 with no shift. */
  get delayS(): number {
    return this.core.parts?.player.shiftDelayS ?? 0;
  }

  /** The lane reference moved by the shift in force. */
  lane(ref: LaneReference | null): LaneReference | null {
    return ref === null || this.applied === 0 ? ref : this.laneMemo.get(ref, this.applied);
  }

  /** The scoring reference moved by `shift` (the one in force when left out). */
  score(ref: ScoreReference | null, shift = this.applied): ScoreReference | null {
    if (ref === null || shift === 0) return ref;
    return shift === this.applied ? this.scoreMemo.get(ref, shift) : transposeScore(ref, shift);
  }

  /** The key map moved by `shift` (the one in force when left out). */
  key(map: KeyMap | null, shift = this.applied): KeyMap | null {
    if (map === null || shift === 0) return map;
    return shift === this.applied ? this.keyMemo.get(map, shift) : transposeKey(map, shift);
  }

  /** The backing notes moved by the shift in force, with the song (W0g). */
  backing(notes: LaneBacking | null): LaneBacking | null {
    return notes === null || this.applied === 0 ? notes : this.backingMemo.get(notes, this.applied);
  }

  /** Moves the song by whole semitones (held to -6..+6) and remembers it for the song. */
  setShift(semitones: number): void {
    if (this.songHash === null || !this.canShift()) return;
    // A shift mid-take would move the reference under frames already stamped.
    if (this.core.store.state.recording) {
      this.core.store.setStatus('Stop recording to change the key.', 'warn');
      return;
    }
    this.wanted = clampShift(semitones);
    saveShift(this.core.settingsStore, this.songHash, this.wanted);
    this.apply();
  }

  /** One semitone up or down from where the song is. */
  step(by: 1 | -1): void {
    this.setShift(Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, this.wanted + by)));
  }

  /**
   * Plays at `semitones` for a take's replay without changing the song's saved
   * choice. Resolves once the sound is there, so its delay can be read.
   */
  lend(semitones: number): Promise<void> {
    this.loan = clampShift(semitones);
    return this.apply();
  }

  /** Gives the song back its own shift after a replay. */
  release(): void {
    if (this.loan === null) return;
    this.loan = null;
    void this.apply();
  }

  /** Takes the suggested shift, if there is one. */
  useSuggested(): void {
    const { suggested } = this.core.store.state.keyShift;
    if (suggested !== null) this.setShift(suggested);
  }

  /** Puts the song back in its own key. */
  reset(): void {
    this.setShift(0);
  }

  /** Recomputes the suggestion and tells the panel and the lane (melody or range changed). */
  refresh(): void {
    const raw = this.core.stems.rawNotes();
    const suggested = suggestShift(melodyRange(raw), this.band);
    const { store, lane } = this.core;
    store.patch({
      keyShift: {
        shift: this.applied,
        suggested,
        canShift: this.canShift(),
        band: this.band ? { lowMidi: this.band.lowMidi, highMidi: this.band.highMidi } : null,
        bandTakes: this.band?.takes ?? 0,
      },
    });
    lane?.setSingerRange(this.band);
  }

  /** Gives a lane attached late the range it missed. */
  syncLane(): void {
    this.core.lane?.setSingerRange(this.band);
  }

  /** Reads the range from the newest learning takes of every song. */
  async refreshRange(): Promise<void> {
    try {
      const all = await (await this.core.takesReady).list();
      const { activeId, legacyId } = this.core.store.state.profiles;
      // The range is the active singer's own: another singer's takes say nothing of it.
      const list = takesOfProfile(all, activeId, legacyId);
      const spans = list.filter((t) => t.kind !== 'mic-check').map((t) => t.report?.voice?.summary.range ?? null);
      this.band = estimateRange(spans);
    } catch {
      this.band = null;
    }
    this.refresh();
  }

  /** True when the song's sound can be moved here: the engine's clock, with AudioWorklet. */
  private canShift(): boolean {
    const { state } = this.core.store;
    // The worklet check is the session's, so tests can stand in for a browser.
    return this.core.parts !== null && this.core.trackerSupported && state.clock === 'engine';
  }

  /** Brings playback, lane and panel to the wanted shift, one change at a time. */
  private apply(): Promise<void> {
    this.queue = this.queue.then(() => this.engage()).catch(() => undefined);
    return this.queue;
  }

  private async engage(): Promise<void> {
    const { core } = this;
    const movable = this.canShift() && core.store.state.song !== null;
    let target = movable ? (this.loan ?? this.wanted) : 0;
    const player = core.parts?.player;
    if (player && typeof player.setShift === 'function' && player.shift !== target) {
      if (!(await player.setShift(target))) {
        target = 0;
        core.store.setStatus('This browser cannot change the key (it needs AudioWorklet).', 'warn');
      }
    }
    if (target !== this.applied) {
      this.applied = target;
      core.stems.syncLane();
      core.backing.syncLane();
    }
    this.refresh();
  }
}
