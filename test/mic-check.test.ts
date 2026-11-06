/**
 * Tests for the Mic check's step machine and its words (src/app/mic-check.ts):
 * the order of the steps, that time only moves forward, that cancel counts
 * only while running, and the countdown.
 */
import { describe, expect, it } from 'vitest';
import { micCheckSections } from '../src/analysis/test-melody';
import {
  initialMicCheck,
  isActivePhase,
  secondsLeft,
  sectionAt,
  STEP_PROMPTS,
  stepMachine,
} from '../src/app/mic-check';
import type { MicCheckPhase } from '../src/app/mic-check';

const sections = micCheckSections();
const run = (phase: MicCheckPhase, songS: number): MicCheckPhase =>
  stepMachine(phase, { type: 'time', songS }, sections);

describe('stepMachine', () => {
  it('walks idle, quiet, speakers, sing-along, sing-alone, analysing, result', () => {
    let p: MicCheckPhase = stepMachine('idle', { type: 'start' }, sections);
    expect(p).toBe('quiet');
    for (const [t, want] of [
      [2, 'quiet'],
      [5, 'speakers'],
      [14.9, 'speakers'],
      [15, 'sing-along'],
      [30, 'sing-alone'],
      [39.9, 'sing-alone'],
    ] as const) {
      p = run(p, t);
      expect(p, `at ${t}`).toBe(want);
    }
    p = stepMachine(p, { type: 'recorded' }, sections);
    expect(p).toBe('analysing');
    expect(stepMachine(p, { type: 'analysed' }, sections)).toBe('result');
    expect(stepMachine(p, { type: 'failed' }, sections)).toBe('failed');
  });

  it('never moves back, and ignores time outside the steps', () => {
    expect(run('sing-along', 3)).toBe('sing-along');
    expect(run('quiet', 45)).toBe('quiet');
    expect(run('idle', 20)).toBe('idle');
    expect(run('result', 20)).toBe('result');
  });

  it('can skip a step if the clock jumped past it', () => {
    expect(run('quiet', 31)).toBe('sing-alone');
  });

  it('cancels only a running check', () => {
    for (const p of ['quiet', 'speakers', 'sing-along', 'sing-alone', 'analysing'] as const) {
      expect(stepMachine(p, { type: 'cancel' }, sections)).toBe('cancelled');
      expect(stepMachine(p, { type: 'failed' }, sections)).toBe('failed');
    }
    for (const p of ['idle', 'result', 'failed', 'cancelled'] as const) {
      expect(stepMachine(p, { type: 'cancel' }, sections)).toBe(p);
    }
  });

  it('starts again from a finished check, but not over a running one', () => {
    for (const p of ['idle', 'result', 'failed', 'cancelled'] as const) {
      expect(stepMachine(p, { type: 'start' }, sections)).toBe('quiet');
    }
    expect(stepMachine('speakers', { type: 'start' }, sections)).toBe('speakers');
  });

  it('closes a finished card to idle and leaves a running check alone', () => {
    expect(stepMachine('result', { type: 'close' }, sections)).toBe('idle');
    expect(stepMachine('failed', { type: 'close' }, sections)).toBe('idle');
    expect(stepMachine('quiet', { type: 'close' }, sections)).toBe('quiet');
  });

  it('follows recorded and analysed only from their own phases', () => {
    expect(stepMachine('idle', { type: 'recorded' }, sections)).toBe('idle');
    expect(stepMachine('quiet', { type: 'analysed' }, sections)).toBe('quiet');
  });
});

describe('the words and the countdown', () => {
  it('says each step in plain words', () => {
    expect(STEP_PROMPTS.quiet).toBe('Stay quiet');
    expect(STEP_PROMPTS['sing-along']).toBe('Sing along with the melody');
  });

  it('finds the step at a time and counts whole seconds left', () => {
    expect(sectionAt(7, sections)?.label).toBe('speakers');
    expect(sectionAt(40, sections)).toBeNull();
    const quiet = sections[0]!;
    expect(secondsLeft(0, quiet)).toBe(5);
    expect(secondsLeft(4.2, quiet)).toBe(1);
    expect(secondsLeft(5, quiet)).toBe(0);
  });

  it('knows which phases are running', () => {
    expect(isActivePhase('analysing')).toBe(true);
    expect(isActivePhase('result')).toBe(false);
    expect(initialMicCheck().phase).toBe('idle');
  });
});
