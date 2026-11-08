/**
 * Saving a take outside the app: the mic settings captured when it was
 * recorded, the JSON document that carries its frames and settings (so a take
 * can be handed over for analysis, for instance to see how much of a video
 * reached the mic), and the file names it is downloaded under. Pure, no DOM;
 * the download itself is src/app/download.ts. Checked in
 * test/take-export.test.ts.
 */
import type { MonitorMode } from '../audio/mic';
import type { MixChoice } from './mix';
import type { AppState } from './state';
import type { TakeMicSettings, TakeRecord } from './takes';

/** Which part of a take a file holds. */
export type TakeFileKind = 'wav' | 'json';

/** The format name and version the JSON carries, for whoever reads it later. */
export const TAKE_EXPORT_FORMAT = 'encore-take';
export const TAKE_EXPORT_VERSION = 3;

/** Longest song name used in a file name. */
const MAX_NAME_CHARS = 60;
/** A floor at or below this is "not measured" (digital silence reads -120). */
const UNMEASURED_FLOOR_DB = -100;

/**
 * The mic and mix settings in force as a take starts: what a reader needs to
 * judge the audio and the frames. `floorDb` is the measured noise floor; one
 * at or below -100 dB means none was measured and is stored as null.
 */
export function captureMicSettings(
  state: Pick<AppState, 'input' | 'output' | 'latencyS' | 'embedOffsetS' | 'mix' | 'embed' | 'song'>,
  clarityThreshold: number,
  floorDb: number,
): TakeMicSettings {
  const { input, song, embed } = state;
  const videoId = embed?.videoId ?? (song?.hash.startsWith('yt-') ? song.hash.slice(3) : null);
  const monitor: MonitorMode = input.monitor;
  const choice: MixChoice = state.mix.choice;
  return {
    inputLabel: input.label,
    monitor,
    processing: { ...input.processing },
    requestedAec: input.requestedAec,
    clarityThreshold,
    latencyS: state.latencyS,
    embedOffsetS: state.embedOffsetS,
    outputLabel: state.output.label,
    mix: { choice, guideLevel: state.mix.guideLevel },
    source: videoId === null ? { kind: 'file', name: song?.name ?? '' } : { kind: 'youtube', videoId },
    noiseFloorDb: floorDb > UNMEASURED_FLOOR_DB ? Math.round(floorDb * 10) / 10 : null,
  };
}

/**
 * The JSON document for a take: format, summary, mic settings, the analysis
 * trace (event log, health over time, environment, melody, key, calibration)
 * and frames.
 */
export function takeExportJson(record: TakeRecord): Record<string, unknown> {
  return {
    format: TAKE_EXPORT_FORMAT,
    version: TAKE_EXPORT_VERSION,
    take: {
      id: record.id,
      songName: record.songName,
      songHash: record.songHash,
      createdAt: new Date(record.createdAt).toISOString(),
      durationS: record.durationS,
      latencyS: record.latencyS,
      sampleRate: record.sampleRate,
      startedAtSongS: record.startedAtSongS ?? null,
      clock: record.clock ?? 'engine',
      kind: record.kind ?? 'song',
    },
    mic: record.mic ?? null,
    report: record.report ?? null,
    // Version 2 adds `trace` and the per-frame `rawF0` and `gate`; version 3
    // adds `take.kind`, `trace.sections` and `trace.environment.tuning`. A
    // take saved before then lacks them and reads as before. The optional
    // `trace.environment.tracker` (search range, filter, faint tier) needed no
    // new version.
    trace: record.trace ?? null,
    frames: record.frames.map((f) => ({
      t: f.t,
      f0: f.f0,
      clarity: f.clarity,
      rms: f.rms,
      ...(f.rawF0 !== undefined ? { rawF0: f.rawF0 } : {}),
      ...(f.gate !== undefined ? { gate: f.gate } : {}),
    })),
  };
}

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * `<song>-<yyyymmdd-hhmm>.<ext>` in local time, the song name cut down to
 * letters, digits and single hyphens.
 */
export function takeFileName(songName: string, createdAt: number, kind: TakeFileKind): string {
  const d = new Date(createdAt);
  const date = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`;
  const stamp = `${date}-${two(d.getHours())}${two(d.getMinutes())}`;
  const name = songName
    .replace(/\.[A-Za-z0-9]{2,4}$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_CHARS)
    .replace(/-+$/g, '');
  return `${name || 'take'}-${stamp}.${kind}`;
}
