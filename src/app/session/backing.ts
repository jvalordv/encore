/**
 * The backing notes of the song in use (W0g): holds what the service
 * transcribed from the instrumental, shows it on the lane (grey bars behind
 * the melody, grey lit keys) and hands it to Save melody. Like the melody, the
 * notes stay as the service gave them and every consumer asks the key
 * controller (`keys.backing`) for the version moved by the shift in force, so
 * the backing moves with the song. The toggle only hides the drawing; the
 * notes are kept. A song without notes (the step was skipped, or failed) just
 * has none: nothing is said, since the backing is a bonus.
 */
import { laneBackingOf } from '../../render/lane-backing';
import type { LaneBacking } from '../../render/lane-backing';
import type { LaneNote } from '../../render/lane-geometry';
import type { BackingNotes } from '../../service/types';
import { initialBacking } from '../backing';
import type { SessionCore } from './core';

/** Owns the backing notes and their visibility. */
export class BackingController {
  private raw: LaneBacking | null = null;
  private shown = true;

  constructor(private readonly core: SessionCore) {}

  /** Takes the service's notes (or none, to forget them) and shows them. */
  set(notes: BackingNotes | null): void {
    this.raw = notes === null ? null : laneBackingOf(notes.notes);
    this.core.store.patch({
      backing: {
        phase: this.raw === null ? 'none' : 'ready',
        notes: this.raw?.notes.length ?? 0,
        shown: this.shown,
      },
    });
    this.syncLane();
  }

  /** Forgets the notes and puts the toggle back to on, for a new song. */
  reset(): void {
    this.shown = true;
    this.raw = null;
    this.core.store.patch({ backing: initialBacking() });
    this.syncLane();
  }

  /** Shows or hides the notes on the lane. */
  setShown(on: boolean): void {
    this.shown = on;
    this.core.store.patch({ backing: { ...this.core.store.state.backing, shown: on } });
    this.core.lane?.setBackingShown?.(on);
  }

  /** The notes moved by the key shift in force; null when there are none. */
  lane(): LaneBacking | null {
    return this.core.keys.backing(this.raw);
  }

  /** The notes for Save melody, moved by the key shift; null when there are none. */
  notesForExport(): readonly LaneNote[] | null {
    return this.lane()?.notes ?? null;
  }

  /** Gives the lane the notes (shifted) and the toggle; also after a shift. */
  syncLane(): void {
    const lane = this.core.lane;
    if (!lane?.setBacking) return;
    lane.setBacking(this.lane());
    lane.setBackingShown?.(this.shown);
  }
}
