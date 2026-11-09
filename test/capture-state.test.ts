/**
 * Tests for the capture machine and its words: the path from the button to a
 * prepared song, the gates on Stop and on a video that ended with too little
 * heard, each way it can fail, and the status line of each phase. Pure: events
 * in, a state and a line out.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_END_COVERAGE,
  NO_AUDIO_MESSAGE,
  canStop,
  captureLine,
  captureReducer,
  initialCapture,
  usableAtEnd,
} from '../src/app/capture';
import type { CaptureEvent, CaptureState } from '../src/app/capture';

function run(events: CaptureEvent[], from: CaptureState = initialCapture()): CaptureState {
  return events.reduce(captureReducer, from);
}

const capturing = (coverage: number, gap = 0): CaptureEvent[] => [
  { type: 'start' },
  { type: 'stream', hasAudio: true },
  { type: 'progress', coverage, largestGapS: gap },
];

describe('captureReducer', () => {
  it('goes from the button to a prepared song', () => {
    let state = run(capturing(0.4));
    expect(state.phase).toBe('capturing');
    expect(state.coverage).toBe(0.4);
    state = run(
      [
        { type: 'progress', coverage: 1, largestGapS: 0 },
        { type: 'finish', reason: 'ended' },
        { type: 'upload-progress', fraction: 0.5 },
      ],
      state,
    );
    expect(state).toMatchObject({ phase: 'uploading', uploadFraction: 0.5 });
    state = run([{ type: 'uploaded' }], state);
    expect(state.phase).toBe('preparing');
    state = run([{ type: 'prepared' }], state);
    expect(state.phase).toBe('ready');
  });

  it('fails with the tab-audio instruction when the share has no sound', () => {
    const state = run([{ type: 'start' }, { type: 'stream', hasAudio: false }]);
    expect(state).toMatchObject({ phase: 'failed', message: NO_AUDIO_MESSAGE });
    expect(NO_AUDIO_MESSAGE).toContain("'Share tab audio'");
  });

  it('refuses Stop below 90 percent and allows it at 90', () => {
    const low = run([...capturing(0.89), { type: 'finish', reason: 'stop' }]);
    expect(low.phase).toBe('capturing');
    expect(canStop(low)).toBe(false);
    const ok = run([...capturing(0.9), { type: 'finish', reason: 'stop' }]);
    expect(ok.phase).toBe('uploading');
  });

  it('sends a video that ended with at least half heard, and fails below that', () => {
    const half = run([...capturing(MIN_END_COVERAGE), { type: 'finish', reason: 'ended' }]);
    expect(half.phase).toBe('uploading');
    const short = run([...capturing(0.3), { type: 'finish', reason: 'ended' }]);
    expect(short.phase).toBe('failed');
    expect(short.message).toContain('30%');
    expect(usableAtEnd(0.49)).toBe(false);
  });

  it('ignores events that do not fit the phase', () => {
    const idle = initialCapture();
    const stray: CaptureEvent[] = [
      { type: 'progress', coverage: 1, largestGapS: 0 },
      { type: 'uploaded' },
      { type: 'prepared' },
      { type: 'fail', message: 'x' },
    ];
    expect(run(stray)).toEqual(idle);
    const busy = run(capturing(0.5));
    expect(captureReducer(busy, { type: 'start' })).toBe(busy);
    expect(captureReducer(busy, { type: 'uploaded' })).toBe(busy);
  });

  it('records a failure in any active phase with its reason', () => {
    const state = run([
      ...capturing(1),
      { type: 'finish', reason: 'ended' },
      { type: 'fail', message: 'The service stopped.' },
    ]);
    expect(state).toMatchObject({ phase: 'failed', message: 'The service stopped.' });
  });

  it('can start again after a failure and clears the old numbers', () => {
    const failed = run([...capturing(0.7), { type: 'fail', message: 'x' }]);
    const again = captureReducer(failed, { type: 'start' });
    expect(again).toEqual({ ...initialCapture(), phase: 'requesting' });
  });

  it('resets from anywhere', () => {
    expect(run([...capturing(0.7), { type: 'reset' }])).toEqual(initialCapture());
  });
});

describe('captureLine', () => {
  it('says what is happening in plain words', () => {
    expect(captureLine(initialCapture())).toBe('');
    expect(captureLine(run([{ type: 'start' }]))).toContain('Share tab audio');
    expect(captureLine(run(capturing(0)))).toContain('Press Play');
    expect(captureLine(run(capturing(0.42, 3.4)))).toBe(
      'Capturing: 42% of the video heard, largest gap 3 s. Let the video play through.',
    );
    expect(captureLine(run(capturing(0.95)))).toBe('Capturing: 95% of the video heard.');
    const uploading = run([
      ...capturing(1),
      { type: 'finish', reason: 'ended' },
      { type: 'upload-progress', fraction: 0.6 },
    ]);
    expect(captureLine(uploading)).toBe('Uploading the capture: 60%');
    expect(captureLine(captureReducer(uploading, { type: 'uploaded' }))).toContain('Preparing');
    expect(captureLine(run([{ type: 'start' }, { type: 'fail', message: 'No luck.' }]))).toBe('No luck.');
  });
});
