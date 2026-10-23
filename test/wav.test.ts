/**
 * Unit tests for the WAV codec and the take-to-song time mapping: header
 * fields byte by byte, encode/decode round trips against known signals,
 * hand-built stereo and odd-layout files, and the failure messages for files
 * this module cannot read.
 */
import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav, encodeWavBlob, songTimeOfSample } from '../src/audio/wav';

/** A sine at `hz`, peaking at `amp`, so errors show up as shape changes. */
function sine(n: number, hz: number, rate: number, amp = 0.8): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));
}

function tag(view: DataView, at: number): string {
  return String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)));
}

/** Builds a WAV from raw chunks, for layouts encodeWav never writes. */
function build(chunks: { id: string; body: Uint8Array }[]): ArrayBuffer {
  let size = 4;
  for (const c of chunks) size += 8 + c.body.length + (c.body.length & 1);
  const out = new Uint8Array(8 + size);
  const view = new DataView(out.buffer);
  out.set([...'RIFF'].map((ch) => ch.charCodeAt(0)), 0);
  view.setUint32(4, size, true);
  out.set([...'WAVE'].map((ch) => ch.charCodeAt(0)), 8);
  let at = 12;
  for (const c of chunks) {
    out.set([...c.id].map((ch) => ch.charCodeAt(0)), at);
    view.setUint32(at + 4, c.body.length, true);
    out.set(c.body, at + 8);
    at += 8 + c.body.length + (c.body.length & 1);
  }
  return out.buffer;
}

/** A 16-byte fmt body. */
function fmt(format: number, channels: number, rate: number, bits: number): Uint8Array {
  const body = new Uint8Array(16);
  const view = new DataView(body.buffer);
  const blockAlign = (channels * bits) / 8;
  view.setUint16(0, format, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, rate, true);
  view.setUint32(8, rate * blockAlign, true);
  view.setUint16(12, blockAlign, true);
  view.setUint16(14, bits, true);
  return body;
}

function int16Bytes(values: number[]): Uint8Array {
  const body = new Uint8Array(values.length * 2);
  const view = new DataView(body.buffer);
  values.forEach((v, i) => view.setInt16(i * 2, v, true));
  return body;
}

function float32Bytes(values: number[]): Uint8Array {
  const body = new Uint8Array(values.length * 4);
  const view = new DataView(body.buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return body;
}

describe('encodeWav header', () => {
  it('writes a canonical 16-bit mono header', () => {
    const buf = encodeWav(sine(100, 440, 48000), 48000);
    const view = new DataView(buf);
    expect(buf.byteLength).toBe(44 + 200);
    expect(tag(view, 0)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(buf.byteLength - 8);
    expect(tag(view, 8)).toBe('WAVE');
    expect(tag(view, 12)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(96000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(tag(view, 36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(200);
  });

  it('writes the float format tag and 4-byte frames for 32-bit', () => {
    const buf = encodeWav(sine(10, 440, 44100), 44100, 32);
    const view = new DataView(buf);
    expect(buf.byteLength).toBe(44 + 40);
    expect(view.getUint16(20, true)).toBe(3);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(28, true)).toBe(44100 * 4);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(32);
    expect(view.getUint32(40, true)).toBe(40);
  });

  it('encodes an empty take as a header only', () => {
    const buf = encodeWav(new Float32Array(0), 48000);
    expect(buf.byteLength).toBe(44);
    expect(decodeWav(buf).pcm.length).toBe(0);
  });

  it('clips 16-bit at full scale and silences non-finite samples', () => {
    const view = new DataView(encodeWav(Float32Array.of(2, -2, 1, -1, NaN, Infinity), 48000));
    const ints = [0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true));
    expect(ints).toEqual([32767, -32768, 32767, -32768, 0, 0]);
  });

  it('keeps overdriven values in float but silences non-finite ones', () => {
    const out = decodeWav(encodeWav(Float32Array.of(2, -3, NaN, -Infinity), 48000, 32)).pcm;
    expect(Array.from(out)).toEqual([2, -3, 0, 0]);
  });

  it('rejects rates and depths a header cannot describe', () => {
    expect(() => encodeWav(new Float32Array(1), 0)).toThrow(RangeError);
    expect(() => encodeWav(new Float32Array(1), 44100.5)).toThrow(RangeError);
    expect(() => encodeWav(new Float32Array(1), 48000, 24 as 16)).toThrow(RangeError);
  });

  it('wraps the bytes in an audio/wav blob', async () => {
    const blob = encodeWavBlob(sine(8, 440, 48000), 48000);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 16);
    expect(tag(new DataView(await blob.arrayBuffer()), 0)).toBe('RIFF');
  });
});

describe('encode then decode', () => {
  const rate = 48000;

  it('round-trips 16-bit within one step of full scale', () => {
    const pcm = sine(4800, 220, rate, 0.95);
    pcm[10] = 1;
    pcm[11] = -1;
    const out = decodeWav(encodeWav(pcm, rate));
    expect(out.sampleRate).toBe(rate);
    expect(out.channels).toBe(1);
    expect(out.pcm.length).toBe(pcm.length);
    let worst = 0;
    for (let i = 0; i < pcm.length; i++) worst = Math.max(worst, Math.abs(out.pcm[i] - pcm[i]));
    expect(worst).toBeLessThanOrEqual(1 / 32768);
  });

  it('round-trips 32-bit float exactly', () => {
    const pcm = sine(4800, 331, 44100, 0.7);
    pcm[0] = 1.5;
    pcm[1] = -1e-7;
    const out = decodeWav(encodeWav(pcm, 44100, 32));
    expect(out.sampleRate).toBe(44100);
    expect(Array.from(out.pcm)).toEqual(Array.from(pcm));
  });
});

describe('decodeWav', () => {
  it('averages 16-bit stereo to mono and reports two channels', () => {
    const wav = build([
      { id: 'fmt ', body: fmt(1, 2, 32000, 16) },
      { id: 'data', body: int16Bytes([16384, 0, -16384, 16384, 32767, -32768]) },
    ]);
    const out = decodeWav(wav);
    expect(out.channels).toBe(2);
    expect(out.sampleRate).toBe(32000);
    expect(Array.from(out.pcm)).toEqual([0.25, 0, -0.5 / 32768]);
  });

  it('averages float stereo to mono', () => {
    const wav = build([
      { id: 'fmt ', body: fmt(3, 2, 48000, 32) },
      { id: 'data', body: float32Bytes([1, 0.5, -0.25, 0.25]) },
    ]);
    const out = decodeWav(wav);
    expect(out.channels).toBe(2);
    expect(Array.from(out.pcm)).toEqual([0.75, 0]);
  });

  it('skips unknown chunks and honours the pad byte after odd sizes', () => {
    const wav = build([
      { id: 'LIST', body: new Uint8Array(5) },
      { id: 'fmt ', body: fmt(1, 1, 48000, 16) },
      { id: 'junk', body: new Uint8Array(3) },
      { id: 'data', body: int16Bytes([16384, -16384]) },
    ]);
    expect(Array.from(decodeWav(wav).pcm)).toEqual([0.5, -0.5]);
  });

  it('reads the real format out of an extensible header', () => {
    const body = new Uint8Array(40);
    body.set(fmt(0xfffe, 1, 48000, 32));
    const view = new DataView(body.buffer);
    view.setUint16(16, 22, true);
    view.setUint16(18, 32, true);
    view.setUint16(24, 3, true);
    const wav = build([
      { id: 'fmt ', body },
      { id: 'data', body: float32Bytes([0.5, -0.125]) },
    ]);
    expect(Array.from(decodeWav(wav).pcm)).toEqual([0.5, -0.125]);
  });

  it('reads as far as the bytes go when the data size overruns the file', () => {
    const wav = new Uint8Array(
      build([
        { id: 'fmt ', body: fmt(1, 1, 48000, 16) },
        { id: 'data', body: int16Bytes([8192, 16384, -8192]) },
      ]),
    );
    new DataView(wav.buffer).setUint32(wav.length - 6 - 4, 0xffffffff, true);
    // One stray byte after the last whole frame is ignored.
    const cut = wav.slice(0, wav.length - 1);
    expect(Array.from(decodeWav(cut.buffer).pcm)).toEqual([0.25, 0.5]);
  });

  it('explains what is wrong with files it cannot read', () => {
    expect(() => decodeWav(new ArrayBuffer(4))).toThrow(/RIFF/);
    expect(() => decodeWav(new TextEncoder().encode('RIFFxxxxAVI LIST').buffer)).toThrow(/RIFF\/WAVE/);
    expect(() => decodeWav(build([{ id: 'data', body: new Uint8Array(4) }]))).toThrow(/fmt/);
    expect(() => decodeWav(build([{ id: 'fmt ', body: fmt(1, 1, 48000, 16) }]))).toThrow(/data/);
    const wav24 = build([
      { id: 'fmt ', body: fmt(1, 1, 48000, 24) },
      { id: 'data', body: new Uint8Array(6) },
    ]);
    expect(() => decodeWav(wav24)).toThrow(/24-bit/);
  });
});

describe('songTimeOfSample', () => {
  it('adds the offset into the take and takes the latency off', () => {
    expect(songTimeOfSample(0, 48000, 12, 0)).toBe(12);
    expect(songTimeOfSample(48000, 48000, 12, 0)).toBe(13);
    expect(songTimeOfSample(24000, 48000, 10, 0.25)).toBeCloseTo(10.25, 12);
  });

  it('can land before song time zero for an early take', () => {
    expect(songTimeOfSample(0, 48000, 0.05, 0.12)).toBeCloseTo(-0.07, 12);
  });

  it('puts an impulse where the singer answered it', () => {
    // A click recorded 0.3 s into a take that began at song time 5 s, with
    // 0.1 s of round trip, answers the song at 5.2 s.
    const rate = 48000;
    const index = Math.round(0.3 * rate);
    expect(songTimeOfSample(index, rate, 5, 0.1)).toBeCloseTo(5.2, 9);
  });
});
