/**
 * Encodes the reference melody as a Standard MIDI File (type 0, one track).
 * Time is 1 ms per tick: 1000 ticks per quarter at 60 bpm (a tempo of
 * 1,000,000 microseconds per quarter), so a note's seconds convert to ticks
 * by a plain multiply and any player keeps the melody's own timing. Notes are
 * rounded to the nearest semitone; the cents are left out. Pure bytes, no
 * browser API, so it is tested against known output.
 */
import type { LaneNote } from '../render/lane-geometry';

/** Ticks per quarter note, which at 60 bpm makes one tick a millisecond. */
export const MIDI_DIVISION = 1000;
/** Velocity every note is written with. */
const VELOCITY = 96;

/** Variable-length quantity: seven bits per byte, high bit on all but last. */
export function vlq(value: number): number[] {
  let rest = Math.max(0, Math.floor(value));
  const bytes = [rest & 0x7f];
  rest = Math.floor(rest / 128);
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return bytes;
}

interface Event {
  tick: number;
  /** 0 for a note-off, which sorts before a note-on at the same tick. */
  on: 0 | 1;
  key: number;
}

/**
 * The note events, time-ordered. A note that would still sound when the same
 * pitch starts again is cut at that start, so the repeat is a fresh strike
 * and every on has exactly one off. A note cut down to nothing, because the
 * same pitch starts on the same tick, is dropped: the later note stands in
 * for it, and a zero-length on/off would only sort into a double note-on.
 */
function eventsOf(notes: readonly LaneNote[]): Event[] {
  const spans = notes
    .map((n) => {
      const start = Math.max(0, Math.round(n.onsetS * 1000));
      return {
        key: Math.min(127, Math.max(0, Math.round(n.midi))),
        start,
        end: Math.max(start + 1, Math.round(n.offsetS * 1000)),
      };
    })
    .sort((a, b) => a.start - b.start);
  const events: Event[] = [];
  const nextStart = new Map<number, number>();
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    const next = nextStart.get(span.key);
    const end = next !== undefined ? Math.min(span.end, next) : span.end;
    if (end <= span.start) {
      nextStart.set(span.key, span.start);
      continue;
    }
    events.push({ tick: span.start, on: 1, key: span.key }, { tick: end, on: 0, key: span.key });
    nextStart.set(span.key, span.start);
  }
  return events.sort((a, b) => a.tick - b.tick || a.on - b.on || a.key - b.key);
}

/** The melody as the bytes of a type 0 Standard MIDI File. */
export function encodeMelodyMidi(notes: readonly LaneNote[]): Uint8Array {
  const track: number[] = [0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40];
  let last = 0;
  for (const e of eventsOf(notes)) {
    track.push(...vlq(e.tick - last), e.on === 1 ? 0x90 : 0x80, e.key, e.on === 1 ? VELOCITY : 0);
    last = e.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, MIDI_DIVISION >> 8, MIDI_DIVISION & 0xff];
  const size = track.length;
  const chunk = [0x4d, 0x54, 0x72, 0x6b, (size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff];
  return Uint8Array.from([...head, ...chunk, ...track]);
}
