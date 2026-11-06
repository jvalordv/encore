/**
 * The Mic check's pure parts: the step machine (idle, the four timed steps,
 * analysing, then a result, a failure or a cancel), the words each step shows,
 * the countdown, and the state the panel renders. The session controller
 * (session/mic-check.ts) feeds the machine the song clock; nothing here
 * touches audio or the DOM. The check speaks about the mic and the room only,
 * never the singing. Checked in test/mic-check.test.ts.
 */
import type { MelodyRange, MicCheckSection, SectionLabel } from '../analysis/test-melody';
import type { TakeAnalysis } from '../service/types';

/** Where a check is. */
export type MicCheckPhase =
  | 'idle'
  | SectionLabel
  | 'analysing'
  | 'result'
  | 'failed'
  | 'cancelled';

/** The phases in which the song clock runs the check. */
export const TIMED_PHASES: readonly MicCheckPhase[] = ['quiet', 'speakers', 'sing-along', 'sing-alone'];

/** What moves the machine. */
export type MicCheckEvent =
  | { type: 'start' }
  | { type: 'time'; songS: number }
  | { type: 'recorded' }
  | { type: 'analysed' }
  | { type: 'failed' }
  | { type: 'cancel' }
  | { type: 'close' };

/** True while a check is running (timed steps and analysing). */
export function isActivePhase(phase: MicCheckPhase): boolean {
  return phase === 'analysing' || TIMED_PHASES.includes(phase);
}

/** The step the clock is in, or null once it is past the last. */
export function sectionAt(songS: number, sections: readonly MicCheckSection[]): MicCheckSection | null {
  return sections.find((s) => songS >= s.startS && songS < s.endS) ?? null;
}

/**
 * The next phase. Time only moves forward through the steps, a late event for
 * a finished phase changes nothing, and a cancel counts only while running.
 */
export function stepMachine(
  phase: MicCheckPhase,
  event: MicCheckEvent,
  sections: readonly MicCheckSection[],
): MicCheckPhase {
  switch (event.type) {
    case 'start':
      return isActivePhase(phase) ? phase : 'quiet';
    case 'time': {
      if (!TIMED_PHASES.includes(phase)) return phase;
      const now = sectionAt(event.songS, sections);
      if (now === null) return phase;
      const order = (p: MicCheckPhase): number => TIMED_PHASES.indexOf(p);
      return order(now.label) > order(phase) ? now.label : phase;
    }
    case 'recorded':
      return TIMED_PHASES.includes(phase) ? 'analysing' : phase;
    case 'analysed':
      return phase === 'analysing' ? 'result' : phase;
    case 'failed':
      return isActivePhase(phase) ? 'failed' : phase;
    case 'cancel':
      return isActivePhase(phase) ? 'cancelled' : phase;
    case 'close':
      return isActivePhase(phase) ? phase : 'idle';
  }
}

/** The plain prompt a step shows. */
export const STEP_PROMPTS: Readonly<Record<SectionLabel, string>> = Object.freeze({
  quiet: 'Stay quiet',
  speakers: 'Stay silent while the melody plays',
  'sing-along': 'Sing along with the melody',
  'sing-alone': 'Keep singing, the melody has stopped',
});

/** Said under the prompt of each step, in plain words. */
export const STEP_HINTS: Readonly<Record<SectionLabel, string>> = Object.freeze({
  quiet: 'This measures the noise in your room.',
  speakers: 'This measures how much of the melody reaches the mic.',
  'sing-along': 'Any tune will do; this is about the mic, not your singing.',
  'sing-alone': 'Carry on with the same tune.',
});

/** Whole seconds left in `section` at `songS`, never below zero. */
export function secondsLeft(songS: number, section: MicCheckSection): number {
  return Math.max(0, Math.ceil(section.endS - songS - 1e-9));
}

/** Said when the mic or speakers are not the ones the check measured. */
export const PAIR_CHANGED = 'The mic or speakers changed since the check; run it again.';

/** What the panel needs to draw. */
export interface MicCheckState {
  phase: MicCheckPhase;
  range: MelodyRange;
  /** Whole seconds left in the step; 0 outside the timed steps. */
  stepLeftS: number;
  /** The service's analysis once it has answered. */
  analysis: TakeAnalysis | null;
  /** Why the check ended without a result: a failure, a cancel, no service. */
  message: string | null;
  /** True when the take is saved and the analysis could not be had. */
  needsService: boolean;
  /** The saved take, for Save WAV and Save JSON. */
  takeId: string | null;
  /** True once the singer has pressed Use these settings for this analysis. */
  applied: boolean;
  /** True when the mic or speakers differ from the ones the check ran on. */
  pairChanged: boolean;
}

/** A check that has not begun. */
export function initialMicCheck(): MicCheckState {
  return {
    phase: 'idle',
    range: 'low',
    stepLeftS: 0,
    analysis: null,
    message: null,
    needsService: false,
    takeId: null,
    applied: false,
    pairChanged: false,
  };
}
