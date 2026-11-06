/**
 * Everything a take keeps for analysis besides its audio and f0 trace: each
 * frame's raw reading and gate verdict, the mic's health sampled over time, a
 * timed log of what happened while it was recorded, the reference melody and
 * key under it, and the environment it ran in. The types are stored with the
 * take (src/app/takes.ts) and written to its JSON (take-export.ts); the
 * recorder here builds the event log by diffing the state store, so no
 * controller has to announce anything. Nothing here is ever drawn in karaoke
 * mode. Checked in test/take-trace.test.ts.
 */
import type { BleedState } from '../analysis/bleed';
import { DRAW_MARGIN_DB, rmsToDb } from '../analysis/mic-level';
import type { MicState } from '../analysis/mic-level';
import type { PitchFrame } from '../analysis/pitch';
import type { TrialResult } from '../audio/latency';
import type { LaneNote, LaneReference } from '../render/lane-geometry';
import type { KeyMap } from '../service/types';
import type { AppState } from './state';

/** Why a frame failed the level gate, in the order the gate checks. */
export type GateReason = 'unvoiced' | 'unclear' | 'quiet';

/**
 * A stored frame. `f0`, `clarity` and `rms` are what scoring and replay read
 * and are unchanged: in speaker mode a gated frame has f0 = 0. The extras
 * are optional: `rawF0` is the tracker's own f0 and appears only when it
 * differs from `f0`; `gate` appears only when the frame failed the gate.
 */
export interface TakeFrame extends PitchFrame {
  rawF0?: number;
  gate?: GateReason;
}

/** The mic's condition at one moment of the take. */
export interface HealthSample {
  /** Song time in seconds. */
  t: number;
  floorDb: number;
  micState: MicState;
  bleed: BleedState;
}

/** What kind of thing happened; `seek` is inferred from a jump in position. */
export type TakeEventKind =
  | 'player'
  | 'seek'
  | 'loop'
  | 'mix'
  | 'guide-level'
  | 'mode'
  | 'scoring'
  | 'note-guide'
  | 'input'
  | 'monitor'
  | 'output'
  | 'latency'
  | 'truncated';

/** One entry of the timed log. */
export interface TakeEvent {
  /** Seconds since the take started, on the wall clock. */
  at: number;
  /** Song position when it happened. */
  songT: number;
  kind: TakeEventKind;
  /** The new value: a state name, a level, a position, or null for "cleared". */
  value: string | number | boolean | null;
}

/** What the browser and the app were running on when the take was made. */
export interface TakeEnvironment {
  appVersion: string;
  userAgent: string;
  skin: string | null;
  /** What the browser really granted the mic track; null when closed. */
  trackSettings: Record<string, unknown> | null;
  audio: { sampleRate: number; baseLatencyS: number | null; outputLatencyS: number | null } | null;
  analysis: { clarityThreshold: number; octaveInvariant: boolean; scoring: string; mode: string };
}

/** The reference melody over the take's span. */
export interface TraceReference {
  hopS: number;
  /** Song time of the first sample kept. */
  t0S: number;
  f0Hz: number[];
  notes?: LaneNote[];
}

/** The calibration behind the take's latency. */
export interface TraceCalibration {
  delayS: number;
  confidence: number;
  spreadS: number;
  trials: TrialResult[];
}

/** The analysis track of a take. */
export interface TakeTrace {
  health: HealthSample[];
  events: TakeEvent[];
  environment: TakeEnvironment;
  reference?: TraceReference;
  key?: KeyMap;
  calibration?: TraceCalibration;
}

/** Seconds of song time between health samples (about 4 a second). */
export const HEALTH_EVERY_S = 0.25;
/** The log stops growing here, so a take left running cannot fill storage. */
const MAX_EVENTS = 2000;
/** A position this far from where the clock should be is a seek. */
const SEEK_RUNNING_S = 1;
/** A paused position moving more than this was moved by the singer. */
const SEEK_PAUSED_S = 0.05;

/** The frame's gate verdict, mirroring `isDrawable` (src/analysis/mic-level). */
export function gateReasonOf(
  frame: { f0: number; clarity: number; rms: number },
  floorDb: number,
  clarityThreshold: number,
): GateReason | null {
  if (!(frame.f0 > 0)) return 'unvoiced';
  if (!(frame.clarity >= clarityThreshold)) return 'unclear';
  return rmsToDb(frame.rms) >= floorDb + DRAW_MARGIN_DB ? null : 'quiet';
}

/** A frame to store: the scored fields as published, plus the raw reading. */
export function toTakeFrame(frame: PitchFrame, rawF0: number | undefined, gate: GateReason | undefined): TakeFrame {
  const out: TakeFrame = { t: frame.t, f0: frame.f0, clarity: frame.clarity, rms: frame.rms };
  if (rawF0 !== undefined && rawF0 !== frame.f0) out.rawF0 = rawF0;
  if (gate !== undefined) out.gate = gate;
  return out;
}

/** The app version baked in at build time, or 'unknown' outside a build. */
export function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown';
}

/** What `captureEnvironment` reads from the live audio parts and settings. */
export interface EnvironmentSource {
  trackSettings: MediaTrackSettings | null;
  context: { sampleRate: number; baseLatency?: number; outputLatency?: number } | null;
  clarityThreshold: number;
  octaveInvariant: boolean;
}

/** The environment record for a take about to start. */
export function captureEnvironment(src: EnvironmentSource, state: Pick<AppState, 'mode' | 'scoring'>): TakeEnvironment {
  const { context } = src;
  const root = typeof document === 'undefined' ? null : document.documentElement;
  return {
    appVersion: appVersion(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    skin: root?.getAttribute('data-skin') ?? null,
    trackSettings: src.trackSettings ? { ...src.trackSettings } : null,
    audio: context
      ? {
          sampleRate: context.sampleRate,
          baseLatencyS: context.baseLatency ?? null,
          outputLatencyS: context.outputLatency ?? null,
        }
      : null,
    analysis: {
      clarityThreshold: src.clarityThreshold,
      octaveInvariant: src.octaveInvariant,
      scoring: state.scoring,
      mode: state.mode,
    },
  };
}

type Tracked = Record<string, string | number | boolean | null>;

const KIND_OF_FIELD: Record<string, TakeEventKind> = {
  player: 'player',
  loop: 'loop',
  mix: 'mix',
  guideLevel: 'guide-level',
  mode: 'mode',
  scoring: 'scoring',
  noteGuide: 'note-guide',
  input: 'input',
  monitor: 'monitor',
  output: 'output',
  latency: 'latency',
};

/** The few state fields the log follows, flattened to comparable values. */
export function trackedFields(state: AppState): Tracked {
  const { loop } = state;
  return {
    player: state.player,
    loop: loop ? `${loop.startS.toFixed(2)}-${loop.endS.toFixed(2)}` : null,
    mix: state.mix.choice,
    guideLevel: state.mix.guideLevel,
    mode: state.mode,
    scoring: state.scoring,
    noteGuide: state.noteGuide,
    input: state.input.open ? state.input.label : null,
    monitor: state.input.monitor,
    output: state.output.label,
    latency: state.latencyS,
  };
}

/** Builds the event log and the health samples of one take. */
export class TakeTraceRecorder {
  readonly events: TakeEvent[] = [];
  readonly health: HealthSample[] = [];
  private startMs = 0;
  private fields: Tracked = {};
  private lastPos = 0;
  private lastPosMs = 0;
  private running = false;
  private lastHealthT = Number.NEGATIVE_INFINITY;

  /** `now` is a millisecond clock; tests pass a fake one. */
  constructor(private readonly now: () => number) {}

  /** Begins a take from the state as it stands. */
  start(state: AppState): void {
    this.events.length = 0;
    this.health.length = 0;
    this.startMs = this.now();
    this.fields = trackedFields(state);
    this.lastPos = state.positionS;
    this.lastPosMs = this.startMs;
    this.running = state.player === 'playing';
    this.lastHealthT = Number.NEGATIVE_INFINITY;
  }

  /** Feed every state change while recording; logs what moved. */
  onState(state: AppState, changed: ReadonlySet<keyof AppState>): void {
    const nowMs = this.now();
    if (changed.has('positionS')) this.notePosition(state, nowMs);
    const next = trackedFields(state);
    for (const key of Object.keys(next)) {
      if (Object.is(next[key], this.fields[key])) continue;
      this.add(KIND_OF_FIELD[key]!, next[key]!, state.positionS, nowMs);
    }
    if (changed.has('player')) {
      this.running = state.player === 'playing';
      this.lastPosMs = nowMs;
      this.lastPos = state.positionS;
    }
    this.fields = next;
  }

  /** Feed each frame's song time; samples the mic's health about 4 Hz. */
  sampleHealth(songT: number, state: AppState): void {
    if (songT - this.lastHealthT < HEALTH_EVERY_S && songT >= this.lastHealthT) return;
    this.lastHealthT = songT;
    const { floorDb, micState, bleed } = state.input;
    this.health.push({ t: songT, floorDb, micState, bleed: bleed.state });
  }

  private notePosition(state: AppState, nowMs: number): void {
    const pos = state.positionS;
    const expected = this.running ? this.lastPos + (nowMs - this.lastPosMs) / 1000 : this.lastPos;
    const limit = this.running ? SEEK_RUNNING_S : SEEK_PAUSED_S;
    const loop = state.loop;
    // The loop jumping back by itself is the clock, not the singer.
    const wrapped =
      this.running &&
      loop !== null &&
      this.lastPos >= loop.endS - SEEK_RUNNING_S &&
      pos >= loop.startS &&
      pos <= loop.startS + SEEK_RUNNING_S;
    if (!wrapped && Math.abs(pos - expected) > limit) this.add('seek', pos, pos, nowMs);
    this.lastPos = pos;
    this.lastPosMs = nowMs;
  }

  private add(kind: TakeEventKind, value: TakeEvent['value'], songT: number, nowMs: number): void {
    if (this.events.length > MAX_EVENTS) return;
    // One last entry tells the reader the rest was dropped, not that nothing happened.
    if (this.events.length === MAX_EVENTS) {
      kind = 'truncated';
      value = true;
    }
    this.events.push({ at: Math.round(nowMs - this.startMs) / 1000, songT: Math.round(songT * 100) / 100, kind, value });
  }
}

/** The reference melody cut to [fromS, toS], values to a tenth of a hertz. */
export function sliceReference(ref: LaneReference | null, fromS: number, toS: number): TraceReference | undefined {
  if (!ref || !(ref.hopS > 0) || ref.f0Hz.length === 0) return undefined;
  const first = Math.max(0, Math.floor((fromS - ref.t0S) / ref.hopS));
  const last = Math.min(ref.f0Hz.length, Math.ceil((toS - ref.t0S) / ref.hopS) + 1);
  if (last <= first) return undefined;
  const f0Hz: number[] = [];
  for (let i = first; i < last; i++) f0Hz.push(Math.round(ref.f0Hz[i]! * 10) / 10);
  const out: TraceReference = { hopS: ref.hopS, t0S: ref.t0S + first * ref.hopS, f0Hz };
  if (ref.notes) out.notes = ref.notes.filter((n) => n.offsetS >= fromS && n.onsetS <= toS).map((n) => ({ ...n }));
  return out;
}

/** The key map reduced to the segments that overlap [fromS, toS]. */
export function keyForSpan(key: KeyMap | null, fromS: number, toS: number): KeyMap | undefined {
  if (!key) return undefined;
  const segments = key.segments.filter((s) => s.end_s >= fromS && s.start_s <= toS).map((s) => ({ ...s }));
  return { tuning_cents: key.tuning_cents, segments };
}
