/**
 * Tests for the AlignController: a karaoke file whose melody was skipped for
 * want of a singer is matched to an original (a prepared song, or a video the
 * service prepares first), the job is followed through the service, and the
 * borrowed melody comes back so Strict scoring applies. A refusal or a failure
 * leaves the song as it was and says why. The service is stubbed on the
 * client's prototype, as in session-controllers.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isKaraokeTrack } from '../src/app/learning';
import { ServiceClient, ServiceError } from '../src/service/client';
import type { PollOutcome } from '../src/service/client';
import type { AlignmentStatus, Reference, SongStatus, StepStatus } from '../src/service/types';
import { fakeLane, makeHarness } from './session-harness';

const step = (state: StepStatus['state'], detail: string | null = null): StepStatus => ({
  state,
  progress: state === 'done' ? 1 : 0,
  error: null,
  detail,
});

function status(id: string, reference: StepStatus): SongStatus {
  return {
    song_id: id,
    source: 'file',
    steps: {
      fetch: step('skipped'),
      separation: step('done'),
      key: step('done'),
      reference,
      lyrics: step('skipped'),
    },
  };
}

const KARAOKE = status('karaoke1', step('skipped', 'No singing found: the vocal is audible in only 3% of this track.'));

const BORROWED: Reference = {
  contour: { hop_s: 0.01, t0_s: 0, f0_hz: [0, 220, 220], confidence: [0, 1, 1] },
  notes: [{ onset_s: 0.5, offset_s: 1.5, midi: 59, cents_mean: 0, cents_std: 0, scoop_cents: 0 }],
  range: { low_midi: 59, high_midi: 59 },
  unpitched_regions: [],
  aligned_from: 'original1',
  key_offset: 2,
  confidence: 0.9,
};

const done: AlignmentStatus = {
  state: 'done',
  progress: 1,
  original_id: 'original1',
  key_offset: 2,
  confidence: 0.9,
};

/** The service answering the karaoke file's journey, and the alignment calls. */
function service(alignment: AlignmentStatus | Error) {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(true);
  vi.spyOn(ServiceClient.prototype, 'uploadSong').mockImplementation(async () => KARAOKE);
  vi.spyOn(ServiceClient.prototype, 'pollSong').mockResolvedValue({ kind: 'settled', status: KARAOKE } as PollOutcome);
  vi.spyOn(ServiceClient.prototype, 'fetchStem').mockImplementation(async () => ({ bytes: new ArrayBuffer(8), gain: 1 }));
  vi.spyOn(ServiceClient.prototype, 'fetchKey').mockResolvedValue({
    tuning_cents: 0,
    segments: [{ start_s: 0, end_s: 4, tonic: 9, mode: 'minor', confidence: 0.8 }],
  });
  const fetchReference = vi.spyOn(ServiceClient.prototype, 'fetchReference').mockResolvedValue(BORROWED);
  const align = vi
    .spyOn(ServiceClient.prototype, 'alignSong')
    .mockImplementation(async () => (alignment instanceof Error ? Promise.reject(alignment) : status('karaoke1', step('skipped'))));
  vi.spyOn(ServiceClient.prototype, 'pollAlignment').mockImplementation(async (_id, options) => {
    if (!(alignment instanceof Error)) options?.onUpdate?.(alignment);
    return alignment instanceof Error ? null : alignment;
  });
  return { align, fetchReference };
}

async function karaokeSong() {
  const h = makeHarness();
  h.core.lane = fakeLane();
  await h.core.songs.loadSong(new File(['x'], 'karaoke.mp3'));
  await vi.waitFor(() => expect(h.store.state.reference.phase).toBe('skipped'));
  return h;
}

afterEach(() => vi.restoreAllMocks());

describe('AlignController', () => {
  it('matches a prepared song to the karaoke track and brings the melody in', async () => {
    const answers = service(done);
    const h = await karaokeSong();
    answers.fetchReference.mockClear();

    await h.core.align.useSong('original1');

    expect(answers.align).toHaveBeenCalledWith('karaoke1', 'original1', expect.anything());
    expect(h.store.state.align).toMatchObject({ phase: 'done', keyOffset: 2, confidence: 0.9 });
    expect(answers.fetchReference).toHaveBeenCalledTimes(1);
    expect(h.store.state.reference).toMatchObject({ phase: 'ready', notes: 1, alignedFrom: 'original1' });
    expect(isKaraokeTrack(h.store.state)).toBe(false);
  });

  it('shows the reason and leaves the song alone when the match is refused', async () => {
    const reason = 'The arrangement differs too much from the original to follow its melody; Open scoring uses the key instead.';
    const answers = service({ state: 'refused', progress: 0, original_id: 'original1', confidence: 0.2, reason });
    const h = await karaokeSong();
    answers.fetchReference.mockClear();

    await h.core.align.useSong('original1');

    expect(h.store.state.align).toMatchObject({ phase: 'refused', message: reason });
    expect(answers.fetchReference).not.toHaveBeenCalled();
    expect(h.store.state.reference.phase).toBe('skipped');
  });

  it('says why when the service turns the request down', async () => {
    service(new ServiceError('rejected', 'The original has no melody to follow yet.', 422));
    const h = await karaokeSong();

    await h.core.align.useSong('original1');

    expect(h.store.state.align).toMatchObject({
      phase: 'failed',
      message: 'The original has no melody to follow yet.',
    });
  });

  it('prepares a picked video first, without making it the song in use', async () => {
    const answers = service(done);
    const created = vi
      .spyOn(ServiceClient.prototype, 'createSongFromUrl')
      .mockResolvedValue(status('yt-abcdefghijk', step('queued')));
    const h = await karaokeSong();
    const prepared = status('yt-abcdefghijk', step('done'));
    vi.mocked(ServiceClient.prototype.pollSong).mockResolvedValue({ kind: 'settled', status: prepared } as PollOutcome);

    await h.core.align.useVideo('abcdefghijk');

    expect(created).toHaveBeenCalledWith('https://www.youtube.com/watch?v=abcdefghijk', expect.anything());
    expect(answers.align).toHaveBeenCalledWith('karaoke1', 'yt-abcdefghijk', expect.anything());
    expect(h.store.state.song?.name).toBe('karaoke.mp3');
  });

  it('is cleared when another song takes over', async () => {
    service(done);
    const h = await karaokeSong();
    await h.core.align.useSong('original1');

    h.core.stems.reset();

    expect(h.store.state.align.phase).toBe('idle');
  });

  it('refuses at once with no song on the service to match', async () => {
    const h = makeHarness();
    await h.core.align.useSong('original1');
    expect(h.store.state.align.phase).toBe('failed');
  });
});
