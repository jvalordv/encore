/**
 * Songs dropped together, analysed up front: the queue's pure half. Dropping
 * (or choosing) several audio files adds each to the Library, and the Session
 * (session/ingest.ts) sends them one at a time to the service, which separates
 * the vocal and reads the key and the melody. This file holds what the song
 * panel needs to show that as ONE bar under the drop zone: the queue's state
 * and its reducer (order, counts, append while running, the failures), the
 * progress a service status adds up to (`stageOf`), and the words
 * (`ingestView`). Nothing here touches a page, the service or the clock, so
 * each rule is tested alone (test/ingest.test.ts).
 *
 * A song that fails is named with a plain reason and the others go on. With
 * no service the songs are still added, and the bar says once that the
 * analysis needs it. Nothing here judges a singer or a take.
 */
import type { SongSteps, StepStatus } from '../service/types';

/** Where one dropped song stands. */
export type IngestPhase = 'queued' | 'working' | 'done' | 'failed' | 'needs-service';

/** One dropped song in the queue. */
export interface IngestItem {
  id: number;
  /** The file's name, as dropped. */
  name: string;
  phase: IngestPhase;
  /** What the service is doing now, in a word or two ("separating"); '' when nothing. */
  stage: string;
  /** How far along this song is, 0 to 1. */
  progress: number;
  /** Why it failed, in plain words; '' otherwise. */
  failure: string;
}

/** The queue and the files turned away. */
export interface IngestState {
  items: IngestItem[];
  /** Lines for dropped files that are not audio. */
  skipped: string[];
  nextId: number;
}

/** What can happen to the queue. */
export type IngestEvent =
  | { type: 'add'; names: readonly string[] }
  | { type: 'skip'; names: readonly string[] }
  | { type: 'start'; id: number }
  | { type: 'progress'; id: number; stage: string; progress: number }
  | { type: 'finish'; id: number }
  | { type: 'fail'; id: number; reason: string }
  | { type: 'needs-service'; id: number }
  | { type: 'clear' };

/** The queue before anything is dropped. */
export function initialIngest(): IngestState {
  return { items: [], skipped: [], nextId: 1 };
}

/** True while a song is waiting or being analysed. */
export function isBusy(state: IngestState): boolean {
  return state.items.some((item) => item.phase === 'queued' || item.phase === 'working');
}

/** The next song waiting its turn, or null. */
export function nextQueued(state: IngestState): IngestItem | null {
  return state.items.find((item) => item.phase === 'queued') ?? null;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function change(state: IngestState, id: number, fields: Partial<IngestItem>): IngestState {
  if (!state.items.some((item) => item.id === id)) return state;
  return { ...state, items: state.items.map((item) => (item.id === id ? { ...item, ...fields } : item)) };
}

/**
 * Applies one event. Files added while the queue is busy join its end; files
 * added to a finished queue start a new one, so last batch's lines are gone.
 */
export function ingestReducer(state: IngestState, event: IngestEvent): IngestState {
  switch (event.type) {
    case 'add': {
      if (event.names.length === 0) return state;
      const base = isBusy(state) ? state : { ...state, items: [], skipped: [] };
      const added = event.names.map((name, i): IngestItem => ({
        id: base.nextId + i,
        name,
        phase: 'queued',
        stage: '',
        progress: 0,
        failure: '',
      }));
      return { ...base, items: [...base.items, ...added], nextId: base.nextId + added.length };
    }
    case 'skip': {
      if (event.names.length === 0) return state;
      const base = isBusy(state) ? state : { ...state, items: [], skipped: [] };
      return { ...base, skipped: [...base.skipped, ...event.names.map(skippedLine)] };
    }
    case 'start':
      return change(state, event.id, { phase: 'working', stage: '', progress: 0 });
    case 'progress':
      return change(state, event.id, {
        phase: 'working',
        stage: event.stage,
        progress: clamp01(event.progress),
      });
    case 'finish':
      return change(state, event.id, { phase: 'done', stage: '', progress: 1, failure: '' });
    case 'fail':
      return change(state, event.id, { phase: 'failed', stage: '', failure: event.reason });
    case 'needs-service':
      return change(state, event.id, { phase: 'needs-service', stage: '' });
    case 'clear':
      return initialIngest();
  }
}

/** The line for a dropped file that is not audio. */
export function skippedLine(name: string): string {
  return `${name} is not an audio file, so it was skipped.`;
}

/** Why a file the browser could not decode failed, after "<name>: ". */
export const UNREADABLE_REASON = 'no readable audio in this file.';

/** The line under the bar for a song that failed. */
export function failureLine(item: Pick<IngestItem, 'name' | 'failure'>): string {
  return `${item.name}: ${item.failure}`;
}

/** A file name's audio extension, dropped to make a song's title. */
export const AUDIO_EXTENSION = /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|webm)$/i;

/** True for a file the app takes as a song: an audio type, or an audio extension. */
export function isAudioFile(file: Pick<File, 'type' | 'name'>): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXTENSION.test(file.name);
}

/** The steps that make a song's analysis, in the order the service runs them. */
const ANALYSIS_STEPS = [
  { name: 'separation', label: 'separating', weight: 0.55 },
  { name: 'key', label: 'finding the key', weight: 0.1 },
  { name: 'reference', label: 'reading the melody', weight: 0.15 },
] as const;
/** The share of a song's progress that the upload takes. */
const UPLOAD_SHARE = 0.2;

/** How far a step has come, 0 to 1: a finished step counts whole, whichever way it ended. */
function stepFraction(step: StepStatus): number {
  switch (step.state) {
    case 'done':
    case 'skipped':
    case 'failed':
      return 1;
    case 'running':
      return clamp01(step.progress);
    case 'queued':
      return 0;
  }
}

/** What an upload of `fraction` (0 to 1) adds up to. */
export function uploadingStage(fraction: number): { stage: string; progress: number } {
  return { stage: 'uploading', progress: UPLOAD_SHARE * clamp01(fraction) };
}

/**
 * The stage and the progress a service status adds up to. The stage is the
 * running step in a word or two; with none running it is "waiting" until all
 * are over.
 */
export function stageOf(steps: SongSteps | null): { stage: string; progress: number } {
  if (steps === null) return { stage: 'waiting', progress: UPLOAD_SHARE };
  let progress = UPLOAD_SHARE;
  let stage = '';
  let pending = false;
  for (const step of ANALYSIS_STEPS) {
    const status = steps[step.name];
    progress += step.weight * stepFraction(status);
    if (status.state === 'running' && stage === '') stage = step.label;
    if (status.state === 'queued') pending = true;
  }
  if (stage === '') stage = pending ? 'waiting' : 'finishing';
  return { stage, progress: clamp01(progress) };
}

/** What the song panel draws for the queue. */
export interface IngestView {
  /** False while there is nothing to say. */
  visible: boolean;
  /** True while a song is waiting or being analysed; the bar moves. */
  busy: boolean;
  /** The whole queue's progress, 0 to 1. */
  fraction: number;
  /** The one line above the bar. */
  line: string;
  /** One line for each song that failed. */
  failures: string[];
  /** One line for each file that was not audio. */
  skipped: string[];
}

/** "1 song", "5 songs". */
function songs(count: number): string {
  return count === 1 ? '1 song' : `${count} songs`;
}

/** Most lines the bar lists for failures or for skipped files before it sums them up. */
const MAX_LISTED = 3;

/** The failure lines, or the first few and a count of the rest. */
function listFailures(lines: readonly string[]): string[] {
  if (lines.length <= MAX_LISTED) return [...lines];
  const more = lines.length - MAX_LISTED;
  return [...lines.slice(0, MAX_LISTED), more === 1 ? '1 more song failed.' : `${more} more songs failed.`];
}

/** The skipped-file lines, or one line summing them up when there are many. */
function listSkipped(lines: readonly string[]): string[] {
  if (lines.length <= MAX_LISTED) return [...lines];
  return [`${lines.length} files were not audio, so they were skipped.`];
}

/** The words and the bar for a queue. */
export function ingestView(state: IngestState): IngestView {
  const total = state.items.length;
  const failures = listFailures(state.items.filter((item) => item.phase === 'failed').map(failureLine));
  const skipped = listSkipped(state.skipped);
  if (total === 0) {
    return { visible: skipped.length > 0, busy: false, fraction: 0, line: '', failures, skipped };
  }
  const settled = state.items.filter((item) => item.phase !== 'queued' && item.phase !== 'working');
  const current = state.items.find((item) => item.phase === 'working') ?? nextQueued(state);
  const fraction = clamp01(
    (settled.length + (current?.phase === 'working' ? current.progress : 0)) / total,
  );
  if (current !== null) {
    const place = state.items.indexOf(current) + 1;
    const stage = current.stage === '' ? '' : ` (${current.stage})`;
    return {
      visible: true,
      busy: true,
      fraction,
      line: `Analysing ${place} of ${total}: ${current.name}${stage}`,
      failures,
      skipped,
    };
  }
  const done = state.items.filter((item) => item.phase === 'done').length;
  const waiting = state.items.filter((item) => item.phase === 'needs-service').length;
  let line: string;
  if (waiting > 0) {
    // Their Library rows cannot be opened: the file bytes are kept by the
    // service, not the page, so the rest must be dropped again.
    line =
      total === 1
        ? '1 song added. Analysing it needs the service, which is not running.'
        : `${songs(total)} added. Analysing them needs the service, which is not running, ` +
          'so only the first can be played. Drop the others again once it runs.';
  } else if (done === total) {
    line = `${songs(total)} analysed.`;
  } else {
    line = `${done} of ${songs(total)} analysed.`;
  }
  return { visible: true, busy: false, fraction: 1, line, failures, skipped };
}
