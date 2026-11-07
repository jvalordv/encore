/**
 * The type 1 MIDI encoder (W0g): the exact bytes of a one-note-per-track
 * file, a round trip through a small reader that follows both tracks, that the
 * type 0 file is unchanged, and the download's file name.
 */
import { describe, expect, it } from 'vitest';
import { melodyFileName } from '../src/app/melody-download';
import { encodeMelodyAndBackingMidi, encodeMelodyMidi } from '../src/audio/midi-file';

describe('encodeMelodyAndBackingMidi', () => {
  it('writes the exact bytes of one melody note and one backing note', () => {
    const bytes = encodeMelodyAndBackingMidi(
      [{ onsetS: 0, offsetS: 1, midi: 60 }],
      [{ onsetS: 0.5, offsetS: 1.5, midi: 64 }],
    );
    expect([...bytes]).toEqual([
      // MThd, length 6, format 1, two tracks, 1000 ticks per quarter.
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 0x03, 0xe8,
      // Track 1: the tempo, the melody on channel 0, the end.
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 20,
      0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,
      0x00, 0x90, 60, 96,
      0x87, 0x68, 0x80, 60, 0,
      0x00, 0xff, 0x2f, 0x00,
      // Track 2: the backing on channel 1, a softer velocity, the end.
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 14,
      0x83, 0x74, 0x91, 64, 72,
      0x87, 0x68, 0x81, 64, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]);
  });

  /** Reads a type 1 file back: the format, and each track's note spans by channel. */
  function read(bytes: Uint8Array) {
    const u32 = (at: number): number =>
      ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
    const format = (bytes[8] << 8) | bytes[9];
    const tracks = (bytes[10] << 8) | bytes[11];
    let at = 14;
    const out: Array<{ channels: Set<number>; spans: Array<[number, number, number]> }> = [];
    for (let t = 0; t < tracks; t++) {
      expect(String.fromCharCode(...bytes.slice(at, at + 4))).toBe('MTrk');
      const end = at + 8 + u32(at + 4);
      let i = at + 8;
      let tick = 0;
      const open = new Map<string, number>();
      const channels = new Set<number>();
      const spans: Array<[number, number, number]> = [];
      while (i < end) {
        let delta = 0;
        while (bytes[i] & 0x80) delta = (delta << 7) | (bytes[i++] & 0x7f);
        delta = (delta << 7) | bytes[i++];
        tick += delta;
        const status = bytes[i++];
        if (status === 0xff) {
          const type = bytes[i++];
          i += 1 + bytes[i];
          if (type === 0x2f) break;
          continue;
        }
        const channel = status & 0x0f;
        const key = bytes[i];
        const velocity = bytes[i + 1];
        i += 2;
        channels.add(channel);
        const id = `${channel}:${key}`;
        if ((status & 0xf0) === 0x90 && velocity > 0) {
          open.set(id, tick);
        } else {
          spans.push([key, open.get(id) ?? -1, tick]);
          open.delete(id);
        }
      }
      expect(i).toBe(end);
      out.push({ channels, spans });
      at = end;
    }
    expect(at).toBe(bytes.length);
    return { format, tracks: out };
  }

  it('round-trips a melody and an overlapping chord on two channels', () => {
    const melody = [
      { onsetS: 0, offsetS: 1, midi: 60.4 },
      { onsetS: 1, offsetS: 2.5, midi: 62 },
    ];
    const chord = [
      { onsetS: 0, offsetS: 2, midi: 48 },
      { onsetS: 0, offsetS: 2, midi: 55 },
      { onsetS: 0, offsetS: 2, midi: 64 },
      { onsetS: 2, offsetS: 3, midi: 48 },
    ];
    const { format, tracks } = read(encodeMelodyAndBackingMidi(melody, chord));
    expect(format).toBe(1);
    expect(tracks).toHaveLength(2);
    expect([...tracks[0].channels]).toEqual([0]);
    expect([...tracks[1].channels]).toEqual([1]);
    expect(tracks[0].spans.sort()).toEqual([
      [60, 0, 1000],
      [62, 1000, 2500],
    ]);
    expect(tracks[1].spans.sort((a, b) => a[1] - b[1] || a[0] - b[0])).toEqual([
      [48, 0, 2000],
      [55, 0, 2000],
      [64, 0, 2000],
      [48, 2000, 3000],
    ]);
  });

  it('leaves the type 0 melody file as it was', () => {
    const bytes = encodeMelodyMidi([{ onsetS: 0, offsetS: 1, midi: 60 }]);
    expect([...bytes.slice(0, 14)]).toEqual([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x03, 0xe8]);
    expect([...bytes.slice(22)]).toEqual([
      0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40, 0x00, 0x90, 60, 96, 0x87, 0x68, 0x80, 60, 0, 0x00, 0xff, 0x2f, 0x00,
    ]);
  });

  it('gives an empty backing an empty second track', () => {
    const bytes = encodeMelodyAndBackingMidi([{ onsetS: 0, offsetS: 1, midi: 60 }], []);
    expect((bytes[10] << 8) | bytes[11]).toBe(2);
    expect([...bytes.slice(-12)]).toEqual([0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0x00, 0xff, 0x2f, 0x00]);
  });
});

describe('melodyFileName with backing', () => {
  it('names the two-track file apart from the melody-only one', () => {
    expect(melodyFileName('My Song.mp3')).toBe('My Song-melody.mid');
    expect(melodyFileName('My Song.mp3', true)).toBe('My Song-melody-backing.mid');
  });
});
