/**
 * Tests for the queue of songs dropped together, apart from the page and the
 * service: the order they run in, the counts, files appended while it runs, a
 * failure that does not stop the others, the lines for files that are not
 * audio, the progress a service status adds up to, and the one line and bar
 * the panel draws at each point.
 */
import { describe, expect, it } from 'vitest';
import {
  failureLine,
  ingestReducer,
  ingestView,
  initialIngest,
  isAudioFile,
  isBusy,
  nextQueued,
  skippedLine,
  stageOf,
  uploadingStage,
} from '../src/app/ingest';
import type { IngestEvent, IngestState } from '../src/app/ingest';
import type { SongSteps, StepState, StepStatus } from '../src/service/types';

function run(events: IngestEvent[], from: IngestState = initialIngest()): IngestState {
  return events.reduce(ingestReducer, from);
}

function step(state: StepState, progress = 0): StepStatus {
  return { state, progress, error: null, detail: null };
}

function steps(over: Partial<SongSteps> = {}): SongSteps {
  return {
    fetch: step('done', 1),
    separation: step('queued'),
    key: step('queued'),
    reference: step('queued'),
    lyrics: step('queued'),
    ...over,
  };
}

describe('the queue', () => {
  it('starts empty and idle', () => {
    const state = initialIngest();
    expect(state.items).toEqual([]);
    expect(isBusy(state)).toBe(false);
    expect(nextQueued(state)).toBeNull();
  });

  it('queues the files in the order they were dropped, each with its own id', () => {
    const state = run([{ type: 'add', names: ['a.mp3', 'b.mp3', 'c.mp3'] }]);
    expect(state.items.map((i) => [i.id, i.name, i.phase])).toEqual([
      [1, 'a.mp3', 'queued'],
      [2, 'b.mp3', 'queued'],
      [3, 'c.mp3', 'queued'],
    ]);
    expect(isBusy(state)).toBe(true);
    expect(nextQueued(state)?.name).toBe('a.mp3');
  });

  it('runs one at a time: the next waiting song is the first still queued', () => {
    let state = run([{ type: 'add', names: ['a.mp3', 'b.mp3'] }, { type: 'start', id: 1 }]);
    expect(state.items[0].phase).toBe('working');
    expect(nextQueued(state)?.name).toBe('b.mp3');
    state = run([{ type: 'finish', id: 1 }, { type: 'start', id: 2 }], state);
    expect(nextQueued(state)).toBeNull();
    expect(isBusy(state)).toBe(true);
    state = run([{ type: 'finish', id: 2 }], state);
    expect(isBusy(state)).toBe(false);
  });

  it('appends files dropped while it runs, keeping the counts going', () => {
    let state = run([{ type: 'add', names: ['a.mp3', 'b.mp3'] }, { type: 'start', id: 1 }, { type: 'finish', id: 1 }]);
    state = run([{ type: 'add', names: ['c.mp3'] }], state);
    expect(state.items.map((i) => i.name)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
    expect(state.items[2].id).toBe(3);
    expect(ingestView(state).line).toBe('Analysing 2 of 3: b.mp3');
  });

  it('starts afresh when files are dropped on a finished queue', () => {
    let state = run([
      { type: 'add', names: ['a.mp3'] },
      { type: 'start', id: 1 },
      { type: 'fail', id: 1, reason: 'It broke.' },
    ]);
    expect(ingestView(state).failures).toEqual(['a.mp3: It broke.']);
    state = run([{ type: 'add', names: ['b.mp3'] }], state);
    expect(state.items.map((i) => i.name)).toEqual(['b.mp3']);
    expect(ingestView(state).failures).toEqual([]);
    expect(state.items[0].id).toBe(2);
  });

  it('ignores events for songs it does not hold, and an empty add', () => {
    const state = run([{ type: 'add', names: ['a.mp3'] }]);
    expect(ingestReducer(state, { type: 'finish', id: 99 })).toBe(state);
    expect(ingestReducer(state, { type: 'add', names: [] })).toBe(state);
    expect(ingestReducer(state, { type: 'skip', names: [] })).toBe(state);
  });

  it('keeps going after a failure, and lists it by name with its reason', () => {
    const state = run([
      { type: 'add', names: ['a.mp3', 'b.mp3', 'c.mp3'] },
      { type: 'start', id: 1 },
      { type: 'finish', id: 1 },
      { type: 'start', id: 2 },
      { type: 'fail', id: 2, reason: 'The service refused the file (HTTP 415).' },
    ]);
    expect(nextQueued(state)?.name).toBe('c.mp3');
    expect(ingestView(state).failures).toEqual(['b.mp3: The service refused the file (HTTP 415).']);
    expect(failureLine({ name: 'b.mp3', failure: 'x' })).toBe('b.mp3: x');
  });
});

describe('many failures', () => {
  it('lists the first few and counts the rest', () => {
    const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `${n}.mp3`);
    const events: IngestEvent[] = [{ type: 'add', names }];
    names.forEach((_, i) => events.push({ type: 'start', id: i + 1 }, { type: 'fail', id: i + 1, reason: 'no' }));
    const view = ingestView(run(events));
    expect(view.failures).toEqual(['a.mp3: no', 'b.mp3: no', 'c.mp3: no', '2 more songs failed.']);
  });
});

describe('files that are not audio', () => {
  it('knows audio by its type or by its extension', () => {
    expect(isAudioFile({ type: 'audio/mpeg', name: 'x' })).toBe(true);
    expect(isAudioFile({ type: '', name: 'Song.MP3' })).toBe(true);
    expect(isAudioFile({ type: '', name: 'song.flac' })).toBe(true);
    expect(isAudioFile({ type: 'text/plain', name: 'notes.txt' })).toBe(false);
    expect(isAudioFile({ type: '', name: 'cover.jpg' })).toBe(false);
  });

  it('is skipped with a line, and the audio beside it is still queued', () => {
    const state = run([
      { type: 'add', names: ['a.mp3'] },
      { type: 'skip', names: ['notes.txt', 'cover.jpg'] },
    ]);
    expect(state.items).toHaveLength(1);
    expect(ingestView(state).skipped).toEqual([skippedLine('notes.txt'), skippedLine('cover.jpg')]);
    expect(skippedLine('notes.txt')).toBe('notes.txt is not an audio file, so it was skipped.');
  });

  it('is summed up in one line when there are many, so the bar stays short', () => {
    const names = ['a.txt', 'b.txt', 'c.txt', 'd.jpg', 'e.jpg'];
    const view = ingestView(run([{ type: 'skip', names }]));
    expect(view.skipped).toEqual(['5 files were not audio, so they were skipped.']);
    const few = ingestView(run([{ type: 'skip', names: names.slice(0, 3) }]));
    expect(few.skipped).toHaveLength(3);
  });

  it('is shown on its own when nothing else was dropped', () => {
    const view = ingestView(run([{ type: 'skip', names: ['notes.txt'] }]));
    expect(view).toMatchObject({ visible: true, busy: false, line: '' });
    expect(view.skipped).toHaveLength(1);
  });
});

describe('what a service status adds up to', () => {
  it('says "waiting" before the service has said anything', () => {
    expect(stageOf(null)).toEqual({ stage: 'waiting', progress: 0.2 });
    expect(stageOf(steps()).stage).toBe('waiting');
  });

  it('names the step that is running, and moves the bar through its share', () => {
    const early = stageOf(steps({ separation: step('running', 0) }));
    const late = stageOf(steps({ separation: step('running', 1) }));
    expect(early.stage).toBe('separating');
    expect(early.progress).toBeCloseTo(0.2, 5);
    expect(late.progress).toBeCloseTo(0.75, 5);
    expect(stageOf(steps({ separation: step('done', 1), key: step('running', 0.5) }))).toMatchObject({
      stage: 'finding the key',
    });
    expect(stageOf(steps({ separation: step('done', 1), key: step('done', 1), reference: step('running', 0.2) }))).toMatchObject({
      stage: 'reading the melody',
    });
  });

  it('counts a finished step whole whichever way it ended, and ends at the full bar', () => {
    const all = stageOf(
      steps({ separation: step('done', 1), key: step('skipped'), reference: step('failed') }),
    );
    expect(all).toEqual({ stage: 'finishing', progress: 1 });
  });

  it('puts the upload in the first share of the bar', () => {
    expect(uploadingStage(0)).toEqual({ stage: 'uploading', progress: 0 });
    expect(uploadingStage(0.5).progress).toBeCloseTo(0.1, 5);
    expect(uploadingStage(1).progress).toBeCloseTo(0.2, 5);
    expect(uploadingStage(7).progress).toBeCloseTo(0.2, 5);
    expect(uploadingStage(Number.NaN).progress).toBe(0);
  });
});

describe('what the panel draws', () => {
  it('is hidden before anything is dropped', () => {
    expect(ingestView(initialIngest())).toEqual({
      visible: false,
      busy: false,
      fraction: 0,
      line: '',
      failures: [],
      skipped: [],
    });
  });

  it('says which song of how many, by name, with the step in brackets', () => {
    let state = run([{ type: 'add', names: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3'] }]);
    expect(ingestView(state).line).toBe('Analysing 1 of 5: a.mp3');
    state = run([{ type: 'start', id: 1 }, { type: 'finish', id: 1 }, { type: 'start', id: 2 }], state);
    state = run([{ type: 'progress', id: 2, stage: 'separating', progress: 0.5 }], state);
    const view = ingestView(state);
    expect(view.line).toBe('Analysing 2 of 5: b.mp3 (separating)');
    expect(view.busy).toBe(true);
    // One finished song and half of the second, of five.
    expect(view.fraction).toBeCloseTo(1.5 / 5, 5);
  });

  it('moves the one bar through every song, up to full', () => {
    let state = run([{ type: 'add', names: ['a.mp3', 'b.mp3'] }]);
    const fractions: number[] = [ingestView(state).fraction];
    for (const id of [1, 2]) {
      state = run([{ type: 'start', id }, { type: 'progress', id, stage: 'separating', progress: 0.5 }], state);
      fractions.push(ingestView(state).fraction);
      state = run([{ type: 'finish', id }], state);
      fractions.push(ingestView(state).fraction);
    }
    expect(fractions).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('says how many were analysed when it is over, and how many of them when some failed', () => {
    const base: IngestEvent[] = [{ type: 'add', names: ['a.mp3', 'b.mp3'] }, { type: 'start', id: 1 }, { type: 'finish', id: 1 }];
    const ok = run([...base, { type: 'start', id: 2 }, { type: 'finish', id: 2 }]);
    expect(ingestView(ok)).toMatchObject({ busy: false, line: '2 songs analysed.' });
    const one = run([{ type: 'add', names: ['a.mp3'] }, { type: 'start', id: 1 }, { type: 'finish', id: 1 }]);
    expect(ingestView(one).line).toBe('1 song analysed.');
    const bad = run([...base, { type: 'start', id: 2 }, { type: 'fail', id: 2, reason: 'No.' }]);
    expect(ingestView(bad).line).toBe('1 of 2 songs analysed.');
    expect(ingestView(bad).failures).toEqual(['b.mp3: No.']);
  });

  it('says once that the analysis needs the service, with no error wall', () => {
    const state = run([
      { type: 'add', names: ['a.mp3', 'b.mp3', 'c.mp3'] },
      { type: 'start', id: 1 },
      { type: 'needs-service', id: 1 },
      { type: 'start', id: 2 },
      { type: 'needs-service', id: 2 },
      { type: 'start', id: 3 },
      { type: 'needs-service', id: 3 },
    ]);
    const view = ingestView(state);
    expect(view.line).toBe(
      '3 songs added. Analysing them needs the service, which is not running, ' +
        'so only the first can be played. Drop the others again once it runs.',
    );
    expect(view.failures).toEqual([]);
    expect(view.busy).toBe(false);
  });

  it('is cleared by clear', () => {
    const state = run([{ type: 'add', names: ['a.mp3'] }, { type: 'clear' }]);
    expect(state).toEqual(initialIngest());
  });
});
