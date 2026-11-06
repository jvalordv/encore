/**
 * Mic health: the level meter's numbers, the noise floor each frame is gated
 * against, the speaker-bleed check and karaoke mode's opt-in note guide. The
 * input controller hands every tracker frame here before anything else sees
 * it; this controller answers whether the frame is clear and loud enough to
 * draw and score, and publishes what the panels show (throttled, since the
 * tracker runs at 100 frames a second). All the arithmetic is in
 * src/analysis (mic-level, bleed, note-guide); this file only wires it to the
 * state. Nothing here is stored with a take.
 */
import { bleedCheck, BleedDetector, vocalInOutput } from '../../analysis/bleed';
import { isDrawable, MicLevel, SILENCE_DB } from '../../analysis/mic-level';
import { NoteGuide } from '../../analysis/note-guide';
import type { GuideNote } from '../../analysis/note-guide';
import type { PitchFrame } from '../../analysis/pitch';
import type { SessionCore } from './core';

/** Seconds of tracker time between publications to the state. */
const PUBLISH_EVERY_S = 0.1;
/** Levels are published to the nearest half decibel, so hiss does not repaint. */
const DB_STEP = 0.5;

const roundDb = (db: number): number => Math.round(db / DB_STEP) * DB_STEP;

/** Gates frames by level, watches for bleed and drives the note guide. */
export class MicHealthController {
  private readonly level = new MicLevel();
  private readonly guide = new NoteGuide();
  private readonly bleed = new BleedDetector();
  private lastPublishT = Number.NEGATIVE_INFINITY;
  private reading: GuideNote | null = null;

  constructor(private readonly core: SessionCore) {
    // A bleed verdict belongs to the song it was heard over.
    core.store.subscribe((_state, changed) => {
      if (changed.has('song')) this.bleed.reset();
    });
  }

  /** The noise floor in dB; SILENCE_DB until it is known. */
  get floorDb(): number {
    return this.level.floorDb;
  }

  /**
   * Takes one tracker frame (context time) with where the song is. Returns
   * whether the frame may be drawn and scored: voiced, clear, and loud enough
   * above the floor to be a voice.
   */
  observe(frame: PitchFrame, positionS: number): boolean {
    this.level.push(frame.rms);
    const clarity = this.core.parts?.tracker.clarityThreshold ?? this.core.current.clarityThreshold;
    const drawable = isDrawable(frame, this.level.floorDb, clarity);
    if (this.guideOn()) {
      if (drawable) this.guide.push(frame.t, positionS, frame.f0, this.core.scoring.keyMap());
    } else {
      this.guide.reset();
    }
    if (frame.t - this.lastPublishT >= PUBLISH_EVERY_S || frame.t < this.lastPublishT) {
      this.lastPublishT = frame.t;
      this.publish(frame.t);
    }
    return drawable;
  }

  /**
   * Compares a frame that passed the gate with the reference melody at the
   * same song time. Only counts in speaker mode, where the song's vocal could
   * be in the room and the browser has the melody.
   */
  compare(songT: number, frame: PitchFrame, drawable: boolean): void {
    const { store, stems } = this.core;
    if (!drawable || !store.state.input.requestedAec) return;
    const contour = stems.contour();
    if (contour === null || !this.vocalOut()) return;
    this.bleed.push(songT, frame.f0, contour);
  }

  /** Turns the note guide on or off, remembering the choice. */
  setNoteGuide(on: boolean): void {
    const { core } = this;
    if (core.current.noteGuide === on && core.store.state.noteGuide === on) return;
    core.current.noteGuide = on;
    core.persist();
    this.guide.reset();
    this.reading = null;
    core.store.patch({ noteGuide: on, guideReading: null });
  }

  /** Forgets the floor, the guide and the bleed window, as the mic closes. */
  reset(): void {
    this.level.reset();
    this.guide.reset();
    this.bleed.reset();
    this.reading = null;
    this.lastPublishT = Number.NEGATIVE_INFINITY;
    this.core.store.patch({ guideReading: null });
  }

  /** The guide shows in karaoke mode only, and only when asked for. */
  private guideOn(): boolean {
    return this.core.current.noteGuide && this.core.current.mode === 'karaoke';
  }

  private vocalOut(): boolean {
    const { clock, mix } = this.core.store.state;
    return vocalInOutput({ clock, choice: mix.choice, guideLevel: mix.guideLevel });
  }

  private publish(nowS: number): void {
    const { store, stems } = this.core;
    const { input, song } = store.state;
    const inputs = {
      speakers: input.requestedAec,
      hasSong: song !== null,
      vocalOut: this.vocalOut(),
      hasReference: stems.contour() !== null,
    };
    // Frames that did not count for the check leave nothing behind when it is off.
    if (!inputs.speakers || !inputs.vocalOut || !inputs.hasReference) this.bleed.reset();
    store.patchSection('input', {
      levelDb: this.level.ready ? roundDb(this.level.levelDb) : SILENCE_DB,
      floorDb: this.level.ready ? roundDb(this.level.floorDb) : SILENCE_DB,
      micState: this.level.state,
      bleed: bleedCheck(this.bleed, inputs),
    });
    const next = this.guideOn() ? this.guide.read(nowS) : null;
    const same =
      next === this.reading ||
      (next !== null &&
        this.reading !== null &&
        next.note === this.reading.note &&
        next.centsOff === this.reading.centsOff);
    if (!same) {
      this.reading = next;
      store.patch({ guideReading: next });
    }
  }
}
