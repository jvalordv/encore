/**
 * Tests for saving a take (src/app/take-export.ts): the mic settings captured
 * from the state, the JSON document with its frames, the file names, and that
 * the settings survive the take store while an older take without them still
 * exports.
 */
import { describe, expect, it } from 'vitest';
import { initialState } from '../src/app/state';
import {
  captureMicSettings,
  TAKE_EXPORT_FORMAT,
  TAKE_EXPORT_VERSION,
  takeExportJson,
  takeFileName,
} from '../src/app/take-export';
import { memoryTakeStore } from '../src/app/takes';
import type { TakeMicSettings, TakeRecord } from '../src/app/takes';

const mic: TakeMicSettings = {
  inputLabel: 'USB mic',
  monitor: 'speakers',
  processing: { aec: true, ns: false, agc: false },
  requestedAec: true,
  clarityThreshold: 0.9,
  latencyS: 0.143,
  embedOffsetS: 0,
  outputLabel: 'Speakers',
  mix: { choice: 'original', guideLevel: 0.5 },
  source: { kind: 'youtube', videoId: 'abc123' },
  noiseFloorDb: -52.5,
};

function record(extra: Partial<TakeRecord> = {}): TakeRecord {
  return {
    id: 'take-1',
    songHash: 'yt-abc123',
    songName: 'My Song',
    createdAt: Date.UTC(2026, 10, 5, 12, 0, 0),
    durationS: 3.5,
    latencyS: 0.143,
    sampleRate: 48000,
    startedAtSongS: 12.25,
    clock: 'engine',
    frames: [
      { t: 12.3, f0: 220, clarity: 0.95, rms: 0.1 },
      { t: 12.31, f0: 0, clarity: 0.2, rms: 0.001 },
    ],
    wav: new Blob([new Uint8Array(8)], { type: 'audio/wav' }),
    ...extra,
  };
}

describe('captureMicSettings', () => {
  const base = initialState();
  const state = {
    ...base,
    input: {
      ...base.input,
      label: 'USB mic',
      monitor: 'speakers' as const,
      requestedAec: true,
      processing: { aec: true, ns: false, agc: false },
    },
    output: { ...base.output, label: 'Speakers' },
    latencyS: 0.143,
    mix: { ...base.mix, choice: 'original' as const, guideLevel: 0.5 },
    song: { name: 'Fake Video Title', durationS: 213, hash: 'yt-abc123' },
    embed: { videoId: 'abc123' },
  };

  it('reads the devices, processing, mix and source off the state', () => {
    expect(captureMicSettings(state, 0.9, -52.46)).toEqual(mic);
  });

  it('names a dropped file by its name and a prepared video by its id', () => {
    const file = { ...state, embed: null, song: { name: 'a.mp3', durationS: 4, hash: 'abcd' } };
    expect(captureMicSettings(file, 0.9, -52).source).toEqual({ kind: 'file', name: 'a.mp3' });
    const prepared = { ...state, embed: null };
    expect(captureMicSettings(prepared, 0.9, -52).source).toEqual({ kind: 'youtube', videoId: 'abc123' });
  });

  it('stores an unmeasured floor as null', () => {
    expect(captureMicSettings(state, 0.9, -120).noiseFloorDb).toBeNull();
  });
});

describe('takeExportJson', () => {
  it('carries the format, the summary, the mic settings and every frame', () => {
    const json = takeExportJson(record({ mic }));
    expect(json.format).toBe(TAKE_EXPORT_FORMAT);
    expect(json.version).toBe(TAKE_EXPORT_VERSION);
    expect(json.take).toEqual({
      id: 'take-1',
      songName: 'My Song',
      songHash: 'yt-abc123',
      createdAt: '2026-11-05T12:00:00.000Z',
      durationS: 3.5,
      latencyS: 0.143,
      sampleRate: 48000,
      startedAtSongS: 12.25,
      clock: 'engine',
    });
    expect(json.mic).toEqual(mic);
    expect(json.frames).toEqual(record().frames);
  });

  it('survives JSON.stringify and back', () => {
    const text = JSON.stringify(takeExportJson(record({ mic })));
    expect(JSON.parse(text).frames).toHaveLength(2);
  });

  it('exports an older take that has no mic settings, clock or start', () => {
    const old = record();
    delete old.clock;
    delete old.startedAtSongS;
    const json = takeExportJson(old);
    expect(json.mic).toBeNull();
    expect(json.report).toBeNull();
    expect((json.take as { clock: string }).clock).toBe('engine');
    expect((json.take as { startedAtSongS: number | null }).startedAtSongS).toBeNull();
  });
});

describe('takeFileName', () => {
  const at = new Date(2026, 10, 5, 7, 9).getTime();

  it('is the song, the local date and time, and the extension', () => {
    expect(takeFileName('My Song', at, 'wav')).toBe('My-Song-20261105-0709.wav');
    expect(takeFileName('My Song', at, 'json')).toBe('My-Song-20261105-0709.json');
  });

  it('drops a file extension and unsafe characters', () => {
    expect(takeFileName('Queen - Don\'t Stop Me Now (Official).mp3', at, 'wav')).toBe(
      'Queen-Don-t-Stop-Me-Now-Official-20261105-0709.wav',
    );
    expect(takeFileName('a/b\\c:d*e?.wav', at, 'json')).toBe('a-b-c-d-e-20261105-0709.json');
  });

  it('keeps letters from other scripts', () => {
    expect(takeFileName('Ça va très bien', at, 'wav')).toBe('Ça-va-très-bien-20261105-0709.wav');
  });

  it('falls back to "take" for a name with nothing usable, and caps a long one', () => {
    expect(takeFileName('???', at, 'wav')).toBe('take-20261105-0709.wav');
    expect(takeFileName('x'.repeat(200), at, 'wav')).toBe(`${'x'.repeat(60)}-20261105-0709.wav`);
  });
});

describe('mic settings in the take store', () => {
  it('come back on the summary and the record, and are absent on an older take', async () => {
    const store = memoryTakeStore();
    const { id: _a, ...withMic } = record({ mic });
    const { id: _b, ...without } = record();
    const idWith = await store.save(withMic);
    const idWithout = await store.save(without);
    expect((await store.list()).find((t) => t.id === idWith)?.mic).toEqual(mic);
    expect((await store.get(idWith))?.mic).toEqual(mic);
    expect((await store.list()).find((t) => t.id === idWithout)?.mic).toBeUndefined();
  });
});
