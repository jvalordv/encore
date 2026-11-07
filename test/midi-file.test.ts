/**
 * The melody's MIDI encoder: VLQ edge values, the exact bytes of a two-note
 * file, and a round trip through a small parser written here.
 */
import { describe, expect, it } from 'vitest';
import { melodyFileName } from '../src/app/melody-download';
import { encodeMelodyMidi, vlq } from '../src/audio/midi-file';

describe('vlq', () => {
  it('encodes the edge values', () => {
    expect(vlq(0)).toEqual([0x00]);
    expect(vlq(127)).toEqual([0x7f]);
    expect(vlq(128)).toEqual([0x81, 0x00]);
    expect(vlq(16383)).toEqual([0xff, 0x7f]);
    expect(vlq(16384)).toEqual([0x81, 0x80, 0x00]);
  });
});

interface Span {
  startMs: number;
  endMs: number;
  key: number;
}

/** A tiny reader: header checks, then note spans from on/off pairs. */
function parse(bytes: Uint8Array): Span[] {
  const text = (at: number): string => String.fromCharCode(...bytes.slice(at, at + 4));
  expect(text(0)).toBe('MThd');
  expect([bytes[9], bytes[11], (bytes[12] << 8) | bytes[13]]).toEqual([0, 1, 1000]);
  expect(text(14)).toBe('MTrk');
  const size = (bytes[18] << 24) | (bytes[19] << 16) | (bytes[20] << 8) | bytes[21];
  expect(bytes.length).toBe(22 + size);
  let i = 22;
  let tick = 0;
  const open = new Map<number, number>();
  const out: Span[] = [];
  while (i < bytes.length) {
    let delta = 0;
    while (bytes[i] & 0x80) delta = (delta << 7) | (bytes[i++] & 0x7f);
    delta = (delta << 7) | bytes[i++];
    tick += delta;
    const status = bytes[i++];
    if (status === 0xff) {
      const type = bytes[i++];
      const length = bytes[i++];
      i += length;
      if (type === 0x2f) break;
    } else if (status === 0x90) {
      open.set(bytes[i], tick);
      i += 2;
    } else {
      expect(status).toBe(0x80);
      const key = bytes[i];
      out.push({ startMs: open.get(key) as number, endMs: tick, key });
      open.delete(key);
      i += 2;
    }
  }
  expect(open.size).toBe(0);
  return out.sort((a, b) => a.startMs - b.startMs || a.key - b.key);
}

describe('encodeMelodyMidi', () => {
  it('writes exact bytes for two notes', () => {
    const bytes = encodeMelodyMidi([
      { onsetS: 0, offsetS: 0.5, midi: 60 },
      { onsetS: 0.5, offsetS: 1, midi: 62.4 },
    ]);
    // Header, track length 29, tempo, then on/off pairs 500 ticks (0x83 0x74) apart.
    const expected = [
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x03, 0xe8, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0,
      0x1d, 0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40, 0x00, 0x90, 60, 96, 0x83, 0x74, 0x80, 60, 0,
      0x00, 0x90, 62, 96, 0x83, 0x74, 0x80, 62, 0, 0x00, 0xff, 0x2f, 0x00,
    ];
    expect(Array.from(bytes)).toEqual(expected);
  });

  it('round trips through a parser, a repeated pitch re-struck', () => {
    const notes = [
      { onsetS: 0.1, offsetS: 0.9, midi: 64 },
      { onsetS: 0.5, offsetS: 1.2, midi: 64 },
      { onsetS: 20, offsetS: 21.5, midi: 55.6 },
    ];
    expect(parse(encodeMelodyMidi(notes))).toEqual([
      { startMs: 100, endMs: 500, key: 64 },
      { startMs: 500, endMs: 1200, key: 64 },
      { startMs: 20000, endMs: 21500, key: 56 },
    ]);
  });

  it('keeps one on/off pair when two notes of a key start on the same tick', () => {
    const bytes = encodeMelodyMidi([
      { onsetS: 1, offsetS: 1.4, midi: 60 },
      { onsetS: 1.0004, offsetS: 2, midi: 60.2 },
      { onsetS: 1, offsetS: 1.5, midi: 62 },
    ]);
    expect(parse(bytes)).toEqual([
      { startMs: 1000, endMs: 2000, key: 60 },
      { startMs: 1000, endMs: 1500, key: 62 },
    ]);
    // Walk the raw events: no key may get a second on before its off.
    const lit = new Set<number>();
    let ons = 0;
    for (let i = 22; i < bytes.length; i++) {
      if (bytes[i] !== 0x90 && bytes[i] !== 0x80) continue;
      if (bytes[i - 1] === 0xff) continue;
      const key = bytes[i + 1];
      if (bytes[i] === 0x90) {
        expect(lit.has(key)).toBe(false);
        lit.add(key);
        ons++;
      } else lit.delete(key);
      i += 2;
    }
    expect(ons).toBe(2);
  });

  it('writes an empty track for no notes', () => {
    expect(parse(encodeMelodyMidi([]))).toEqual([]);
  });
});

describe('melodyFileName', () => {
  it('drops the extension and unsafe characters', () => {
    expect(melodyFileName('My Song.mp3')).toBe('My Song-melody.mid');
    expect(melodyFileName('a/b:c?.wav')).toBe('a b c-melody.mid');
    expect(melodyFileName('')).toBe('song-melody.mid');
  });
});
