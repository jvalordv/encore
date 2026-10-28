/**
 * Unit tests for the session controllers on fake parts (test/session-harness):
 * the frame bus, loading a song, play/pause/seek/loop, the mic and the frames
 * it puts on the bus, recording a take and replaying it, the switch to
 * prepared audio, and a calibration result. The real Web Audio paths belong to
 * the end-to-end run; here the transport, mic, tracker, recorder and clock
 * only remember what they were asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameBus } from '../src/app/session/frame-bus';
import type { SingerFrame } from '../src/app/session/frame-bus';
import { DUCKED_ORIGINAL_GAIN } from '../src/app/session/takes';
import { loadSettings } from '../src/app/settings';
import { CalibrationError, latencyKey } from '../src/audio/latency';
import type { LatencyResult } from '../src/audio/latency';
import type { YouTubeTransport } from '../src/audio/youtube-transport';
import { ServiceClient, ServiceError } from '../src/service/client';
import type { PollOutcome } from '../src/service/client';
import type { Reference, SongStatus, SongSteps, StepStatus } from '../src/service/types';
import { fakeLane, FakeTransport, makeHarness, songInfo } from './session-harness';

const hoisted = vi.hoisted(() => ({
  measureLatency: vi.fn(),
  prepareLink: vi.fn(),
  followers: [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>,
}));

vi.mock('../src/audio/latency', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/latency')>()),
  measureLatency: hoisted.measureLatency,
}));
vi.mock('../src/app/prepare', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/app/prepare')>()),
  prepareLink: hoisted.prepareLink,
}));
vi.mock('../src/audio/embed-follower', () => ({
  EmbedFollower: class {
    start = vi.fn();
    stop = vi.fn();
    constructor() {
      hoisted.followers.push(this);
    }
  },
}));

// A file load asks the service whether it runs. No test reaches a real one:
// it is away unless a test says otherwise.
beforeEach(() => {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  hoisted.measureLatency.mockReset();
  hoisted.prepareLink.mockReset();
  hoisted.followers.length = 0;
});

/** A harness whose player already holds a loaded, idle song. */
function withSong() {
  const h = makeHarness();
  h.player.setSong(songInfo());
  return h;
}

/** A stand-in for the linked video: an embed-clock transport with a handle. */
class FakeEmbed extends FakeTransport {
  override clock = 'embed' as const;
  videoId = 'abc123';
  readonly mute = vi.fn();
  readonly destroy = vi.fn();
}

function goodResult(delayS = 0.12, confidence = 0.9): LatencyResult {
  return {
    delayS,
    confidence,
    spreadS: 0.002,
    trials: [],
    trialsS: [delayS, delayS + 0.001],
  };
}

/** One step of a song's status, as the service reports it. */
function stepOf(state: StepStatus['state'], extra: Partial<StepStatus> = {}): StepStatus {
  return { state, progress: state === 'done' ? 1 : 0, error: null, detail: null, ...extra };
}

/** A file song's status; by default separation and the melody are done. */
function karaokeStatus(steps: Partial<SongSteps> = {}): SongStatus {
  return {
    song_id: 'abc',
    title: 'Tune',
    duration_s: 100,
    source: 'file',
    steps: {
      fetch: stepOf('skipped'),
      separation: stepOf('done'),
      reference: stepOf('done'),
      lyrics: stepOf('skipped'),
      ...steps,
    },
  };
}

const MELODY: Reference = {
  contour: { hop_s: 0.01, t0_s: 0, f0_hz: [0, 220, 220], confidence: [0, 1, 1] },
  notes: [
    { onset_s: 2, offset_s: 3, midi: 62, cents_mean: 0, cents_std: 0, scoop_cents: 0 },
    { onset_s: 0, offset_s: 1, midi: 57, cents_mean: 0, cents_std: 0, scoop_cents: 0 },
  ],
  range: { low_midi: 57, high_midi: 62 },
  unpitched_regions: [[1, 2]],
};

describe('FrameBus', () => {
  const message = (t: number): SingerFrame => ({
    singer: 0,
    frame: { t, f0: 220, clarity: 0.9, rms: 0.1 },
  });

  it('calls subscribers in the order they joined', () => {
    const bus = new FrameBus();
    const seen: string[] = [];
    bus.subscribe(() => seen.push('first'));
    bus.subscribe(() => seen.push('second'));
    bus.publish(message(1));
    expect(seen).toEqual(['first', 'second']);
  });

  it('stops calling a subscriber that has left, and passes the message whole', () => {
    const bus = new FrameBus();
    const cb = vi.fn();
    const off = bus.subscribe(cb);
    bus.publish(message(1));
    off();
    bus.publish(message(2));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(message(1));
  });
});

describe('SongController', () => {
  it('loads a file, makes the player the song and says so', async () => {
    const h = makeHarness();
    await h.core.songs.loadSong(new File(['x'], 'tune.mp3'));
    expect(h.core.songs.active).toBe(h.player);
    expect(h.store.state.song?.name).toBe('tune.mp3');
    expect(h.store.state.player).toBe('ready');
    expect(h.store.state.status).toEqual({
      text: 'Loaded tune.mp3 (1:40). Pick a microphone, then press Play.',
      kind: 'info',
    });
  });

  it('keeps the song in use, and says so, when a later file will not load', async () => {
    const h = makeHarness();
    await h.core.songs.loadSong(new File(['x'], 'tune.mp3'));
    h.player.load.mockRejectedValueOnce(new Error('Could not decode that file.'));
    await h.core.songs.loadSong(new File(['y'], 'bad.mp3'));
    expect(h.store.state.song?.name).toBe('tune.mp3');
    expect(h.store.state.status.kind).toBe('error');
    expect(h.store.state.status.text).toContain('Could not decode that file.');
    expect(h.store.state.status.text).toContain('still loaded');
  });

  it('lets a newer load win over a slower older one', async () => {
    const h = makeHarness();
    let release!: () => void;
    h.player.load.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...songInfo('old.mp3'), sampleRate: 44100, channels: 1 };
    });
    const older = h.core.songs.loadSong(new File(['a'], 'old.mp3'));
    await h.core.songs.loadSong(new File(['b'], 'new.mp3'));
    release();
    await older;
    expect(h.store.state.song?.name).toBe('new.mp3');
    expect(h.store.state.status.text).toContain('Loaded new.mp3');
  });

  it('turns away text that is not a YouTube link, and a page with no video pane', async () => {
    const h = makeHarness();
    await h.core.songs.loadLink('not a link');
    expect(h.store.state.status).toEqual({
      text: 'That does not look like a YouTube link.',
      kind: 'warn',
    });
    await h.core.songs.loadLink('https://youtu.be/dQw4w9WgXcQ');
    expect(h.store.state.status.kind).toBe('error');
    expect(h.store.state.status.text).toContain('no place to show the YouTube player');
  });

  it('copies the transport into the store as it changes, and notes an ad', () => {
    const h = withSong();
    const lane = fakeLane();
    h.core.lane = lane;
    h.player.positionS = 30;
    h.player.emit('seek');
    expect(h.store.state.positionS).toBe(30);
    expect(lane.setTime).toHaveBeenLastCalledWith(30);
    h.player.state = 'ad';
    h.player.emit('state');
    expect(lane.setNotice).toHaveBeenLastCalledWith('Ad playing: pitch is paused');
    expect(h.store.state.status.kind).toBe('warn');
    h.player.state = 'paused';
    h.player.emit('pause');
    expect(lane.setNotice).toHaveBeenLastCalledWith(null);
    expect(h.store.state.status.text).toBe('The ad ended.');
  });
});

describe('PlaybackController', () => {
  it('asks for a song before it plays', () => {
    const h = makeHarness();
    h.core.playback.play();
    expect(h.store.state.status.text).toContain('Drop an audio file');
    expect(h.player.calls).toEqual([]);
  });

  it('plays, pauses and toggles', () => {
    const h = withSong();
    h.core.playback.play();
    expect(h.store.state.player).toBe('playing');
    h.core.playback.togglePlay();
    expect(h.store.state.player).toBe('paused');
    h.core.playback.togglePlay();
    expect(h.store.state.player).toBe('playing');
    h.core.playback.pause();
    expect(h.player.calls).toEqual(['play', 'pause', 'play', 'pause']);
  });

  it('does not start the song over a calibration', () => {
    const h = withSong();
    h.store.patch({ calibrating: true });
    h.core.playback.play();
    expect(h.player.calls).toEqual([]);
  });

  it('reminds the singer to pick a mic when it plays with none open', () => {
    const h = withSong();
    h.core.playback.play();
    expect(h.store.state.status.text).toBe('Pick a microphone to see your pitch live.');
  });

  it('seeks and nudges only once a song is loaded', () => {
    const h = makeHarness();
    h.core.playback.seek(10);
    h.core.playback.nudge(5);
    expect(h.player.calls).toEqual([]);
    h.player.setSong(songInfo());
    h.core.playback.seek(30);
    h.core.playback.nudge(-5);
    expect(h.player.calls).toEqual(['seek 30', 'seek 25']);
    expect(h.store.state.positionS).toBe(25);
  });

  it('sets a loop from two times, clears it, and refuses one too short', () => {
    const h = withSong();
    h.core.playback.toggleLoop(2, 6);
    expect(h.player.loop).toEqual({ startS: 2, endS: 6 });
    expect(h.store.state.loop).toEqual({ startS: 2, endS: 6 });
    expect(h.store.state.status.text).toBe('Loop 0:02 to 0:06.');
    h.core.playback.toggleLoop();
    expect(h.player.loop).toBeNull();
    expect(h.store.state.status.text).toBe('Loop off.');
    h.core.playback.toggleLoop(5, 5.01);
    expect(h.store.state.status.text).toContain('too short');
  });

  it('jumps to the loop start when B is pressed at the playhead', () => {
    const h = withSong();
    h.player.positionS = 20;
    h.core.playback.setLoopPoint('b');
    expect(h.player.loop).toEqual({ startS: 12, endS: 20 });
    expect(h.player.positionS).toBe(12);
  });

  it('keeps the loop as it is while a take is being recorded', () => {
    const h = withSong();
    h.store.patch({ recording: true });
    h.core.playback.toggleLoop(2, 6);
    expect(h.player.loop).toBeNull();
    expect(h.store.state.status).toEqual({
      text: 'Stop recording before changing the loop.',
      kind: 'warn',
    });
  });
});

describe('InputController and the frame bus', () => {
  async function singing() {
    const h = withSong();
    const lane = fakeLane();
    h.core.lane = lane;
    await h.core.input.chooseInput('usb');
    return { h, lane };
  }

  it('opens the mic, connects the tracker and remembers the device', async () => {
    const { h } = await singing();
    expect(h.mic.open).toHaveBeenCalledWith('usb', 1, 'headphones');
    expect(h.tracker.connect).toHaveBeenCalled();
    expect(h.store.state.input).toMatchObject({ open: true, deviceId: 'usb', label: 'mic usb' });
    expect(h.store.state.tracker).toBe('running');
    expect(h.store.state.status.text).toBe('Microphone ready: mic usb.');
    expect(loadSettings(h.settingsStore).inputDeviceId).toBe('usb');
  });

  it('puts a frame on song time and sends it to the lane and the bus', async () => {
    const { h, lane } = await singing();
    const seen: SingerFrame[] = [];
    h.core.bus.subscribe((m) => seen.push(m));
    h.core.playback.play();
    h.player.positionS = 10;
    h.engine.t = 5;
    h.tracker.emit({ t: 4.99, f0: 220, clarity: 0.95, rms: 0.2 });
    expect(seen).toHaveLength(1);
    expect(seen[0].singer).toBe(0);
    expect(seen[0].frame.t).toBeCloseTo(9.99, 6);
    expect(lane.pushFrame).toHaveBeenCalledTimes(1);
    expect(lane.pushFrame.mock.calls[0][0]).toMatchObject({ f0: 220, clarity: 0.95 });
  });

  it('takes the calibrated latency off the frame time', async () => {
    const { h } = await singing();
    h.core.latency.setLatency(0.1);
    const seen: SingerFrame[] = [];
    h.core.bus.subscribe((m) => seen.push(m));
    h.core.playback.play();
    h.player.positionS = 10;
    h.engine.t = 5;
    h.tracker.emit({ t: 5, f0: 220, clarity: 0.9, rms: 0.1 });
    expect(seen[0].frame.t).toBeCloseTo(9.9, 6);
  });

  it('shows a frame while paused but puts none on the bus', async () => {
    const { h, lane } = await singing();
    const cb = vi.fn();
    h.core.bus.subscribe(cb);
    h.tracker.emit({ t: 1, f0: 220, clarity: 0.9, rms: 0.1 });
    expect(cb).not.toHaveBeenCalled();
    expect(lane.pushFrame).not.toHaveBeenCalled();
    expect(h.core.input.latestFrame).toMatchObject({ f0: 220 });
  });

  it('leaves the lane to a replaying take but still tells the bus', async () => {
    const { h, lane } = await singing();
    const cb = vi.fn();
    h.core.bus.subscribe(cb);
    h.core.playback.play();
    h.store.patch({ playingTakeId: 'take-1' });
    h.tracker.emit({ t: 0, f0: 220, clarity: 0.9, rms: 0.1 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(lane.pushFrame).not.toHaveBeenCalled();
  });

  it('marks the mic closed and says so when the device is unplugged', async () => {
    const { h } = await singing();
    h.mic.unplug();
    expect(h.store.state.input.open).toBe(false);
    expect(h.store.state.tracker).toBe('idle');
    expect(h.store.state.status.kind).toBe('warn');
    expect(h.store.state.status.text).toContain('disconnected');
  });

  it('keeps the first singer in step with the input', async () => {
    const { h } = await singing();
    expect(h.store.state.singers[0].input).toEqual(h.store.state.input);
    expect(h.store.state.singers[0].input.open).toBe(true);
  });
});

describe('TakeController', () => {
  /** Records one second of a take over the loaded song; returns the harness. */
  async function recorded() {
    const h = withSong();
    await h.core.input.chooseInput('usb');
    await h.core.takes.toggleRecord();
    expect(h.store.state.recording).toBe(true);
    h.engine.t = 1;
    h.player.positionS = 1;
    h.tracker.emit({ t: 1, f0: 220, clarity: 0.95, rms: 0.2 });
    await h.core.takes.toggleRecord();
    return h;
  }

  it('starts the song, records from its position and warns about missing calibration', async () => {
    const h = withSong();
    await h.core.input.chooseInput('usb');
    await h.core.takes.toggleRecord();
    expect(h.player.calls).toContain('play');
    expect(h.recorder.start).toHaveBeenCalledWith(0, 0);
    expect(h.store.state.recording).toBe(true);
    expect(h.store.state.status.kind).toBe('warn');
    expect(h.store.state.status.text).toContain('Latency is not calibrated');
  });

  it('saves the take with the frames sung, and pauses the song it started', async () => {
    const h = await recorded();
    expect(h.recorder.stop).toHaveBeenCalledTimes(1);
    expect(h.store.state.recording).toBe(false);
    expect(h.player.state).toBe('paused');
    expect(h.store.state.takes).toHaveLength(1);
    const take = await h.takeStore.get(h.store.state.takes[0].id);
    expect(take?.frames).toEqual([{ t: 1, f0: 220, clarity: 0.95, rms: 0.2 }]);
    expect(take?.songHash).toBe('hash-song');
    expect(take?.clock).toBe('engine');
    expect(h.store.state.status.text).toBe('Take saved (0.1 s).');
  });

  it('refuses to record without a song, with a loop, or with no mic that can be opened', async () => {
    const none = makeHarness();
    await none.core.takes.toggleRecord();
    expect(none.recorder.start).not.toHaveBeenCalled();

    const looped = withSong();
    looped.player.loop = { startS: 1, endS: 5 };
    await looped.core.takes.toggleRecord();
    expect(looped.store.state.status.text).toContain('Clear the loop');

    const mute = withSong();
    await mute.core.takes.toggleRecord();
    expect(mute.store.state.status.text).toBe('Pick a microphone first.');
    expect(mute.recorder.start).not.toHaveBeenCalled();
  });

  it('plays a saved take under the song, ducked, and feeds its trace to the lane', async () => {
    const h = await recorded();
    const lane = fakeLane();
    h.core.lane = lane;
    const id = h.store.state.takes[0].id;
    await h.core.takes.playTake(id);
    expect(h.player.addStem).toHaveBeenCalledWith('take', expect.anything(), 0);
    expect(h.player.setStemGain).toHaveBeenCalledWith('original', DUCKED_ORIGINAL_GAIN);
    expect(h.store.state.playingTakeId).toBe(id);
    expect(h.player.state).toBe('playing');

    h.player.positionS = 1.5;
    h.core.loop.tick(0);
    expect(lane.pushFrame).toHaveBeenCalledWith({ t: 1, f0: 220, clarity: 0.95 });

    h.core.takes.stopTake();
    expect(h.player.removeStem).toHaveBeenCalledWith('take');
    expect(h.player.setStemGain).toHaveBeenLastCalledWith('original', 1);
    expect(h.store.state.playingTakeId).toBeNull();
    expect(h.player.state).toBe('paused');
  });

  it('turns away a take that is gone or belongs to another song', async () => {
    const h = await recorded();
    await h.core.takes.playTake('missing');
    expect(h.store.state.status).toEqual({ text: 'That take is gone.', kind: 'warn' });
    const id = h.store.state.takes[0].id;
    h.player.setSong(songInfo('other.mp3', 'hash-other'));
    await h.core.takes.playTake(id);
    expect(h.store.state.status.text).toBe('That take belongs to another song.');
    expect(h.store.state.playingTakeId).toBeNull();
  });

  it('plays a take by itself under a video, on its own playhead', async () => {
    const h = await recorded();
    const embed = new FakeEmbed();
    embed.setSong(songInfo());
    h.core.songs.active = embed;
    const id = h.store.state.takes[0].id;
    h.engine.t = 10;
    await h.core.takes.playTake(id);
    expect(h.core.takes.solo).not.toBeNull();
    expect(h.store.state.playingTakeId).toBe(id);
    expect(h.store.state.status.text).toContain('by itself');
    h.engine.t = 12;
    expect(h.core.songs.currentPosition()).toBe(2);
    h.core.takes.stopTake();
    expect(h.core.takes.solo).toBeNull();
    expect(h.store.state.playingTakeId).toBeNull();
  });

  it('deletes a take and refreshes the list', async () => {
    const h = await recorded();
    const id = h.store.state.takes[0].id;
    await h.core.takes.deleteTake(id);
    expect(h.store.state.takes).toEqual([]);
    expect(await h.takeStore.get(id)).toBeNull();
    expect(h.store.state.status.text).toBe('Take deleted.');
  });
});

describe('PrepareController', () => {
  function linked() {
    const h = makeHarness();
    const embed = new FakeEmbed();
    embed.setSong(songInfo('Video', 'yt-abc123'));
    embed.state = 'playing';
    embed.positionS = 12;
    h.core.songs.embed = embed as unknown as YouTubeTransport;
    h.core.songs.active = embed;
    h.store.patch({ prepare: { phase: 'ready', steps: null, message: '' } });
    return { h, embed };
  }
  const audio = { kind: 'audio', bytes: new ArrayBuffer(8), status: karaokeStatus() };

  it('hands a going song from the video to the app, muting the video', async () => {
    const { h, embed } = linked();
    vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(true);
    hoisted.prepareLink.mockResolvedValue(audio);
    await h.core.prepare.prepare();

    const [file, name, key] = h.player.load.mock.calls[0];
    expect(file.name).toBe('abc123.flac');
    expect([name, key]).toEqual(['Video', 'yt-abc123']);
    expect(embed.mute).toHaveBeenCalledTimes(1);
    expect(embed.calls).not.toContain('pause');
    expect(h.player.calls).toEqual(['seek 12', 'play']);
    expect(h.core.songs.active).toBe(h.player);
    expect(h.store.state.prepare.phase).toBe('prepared');
    expect(hoisted.followers).toHaveLength(1);
    expect(hoisted.followers[0].start).toHaveBeenCalled();
  });

  it("then follows the service for the song's karaoke track", async () => {
    const { h } = linked();
    vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(true);
    hoisted.prepareLink.mockResolvedValue(audio);
    const follow = vi.spyOn(h.core.stems, 'follow').mockImplementation(() => undefined);
    await h.core.prepare.prepare();
    expect(follow).toHaveBeenCalledWith(audio.status);
  });

  it('says so, and offers nothing, when the service has stopped', async () => {
    const { h, embed } = linked();
    vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
    await h.core.prepare.prepare();
    expect(h.store.state.prepare.phase).toBe('unavailable');
    expect(h.store.state.status.kind).toBe('warn');
    expect(hoisted.prepareLink).not.toHaveBeenCalled();
    expect(embed.mute).not.toHaveBeenCalled();
  });

  it('shows Prepare after a check, and checks again on request', async () => {
    const { h, embed } = linked();
    const health = vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
    await h.core.prepare.probeService(embed as unknown as YouTubeTransport);
    expect(h.store.state.prepare.phase).toBe('unavailable');
    health.mockResolvedValue(true);
    h.core.prepare.checkService();
    await vi.waitFor(() => expect(h.store.state.prepare.phase).toBe('ready'));
    expect(hoisted.prepareLink).not.toHaveBeenCalled();
  });

  it('sends the link by itself after the check when the setting is on', async () => {
    const { h, embed } = linked();
    h.core.prepare.setAutoPrepareLinks(true);
    expect(loadSettings(h.settingsStore).autoPrepareLinks).toBe(true);
    vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(true);
    hoisted.prepareLink.mockResolvedValue(audio);
    await h.core.prepare.probeService(embed as unknown as YouTubeTransport);
    await vi.waitFor(() => expect(h.store.state.prepare.phase).toBe('prepared'));
  });

  it('is ended by a newer load, which takes the player and leaves the video unmuted', async () => {
    const { h, embed } = linked();
    vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(true);
    let finish!: (outcome: unknown) => void;
    hoisted.prepareLink.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const run = h.core.prepare.prepare();
    await vi.waitFor(() => expect(h.store.state.prepare.phase).toBe('preparing'));
    await h.core.songs.loadSong(new File(['x'], 'next.mp3'));
    finish(audio);
    await run;
    expect(embed.mute).not.toHaveBeenCalled();
    expect(h.player.load).toHaveBeenCalledTimes(1);
    expect(h.store.state.song?.name).toBe('next.mp3');
    expect(h.store.state.prepare.phase).toBe('none');
    expect(h.core.songs.active).toBe(h.player);
  });

  it('waits for a take being recorded before it switches', async () => {
    const { h, embed } = linked();
    vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(true);
    hoisted.prepareLink.mockResolvedValue(audio);
    h.store.patch({ recording: true });
    const run = h.core.prepare.prepare();
    await vi.waitFor(() => expect(h.store.state.prepare.phase).toBe('waiting'));
    expect(embed.mute).not.toHaveBeenCalled();
    h.store.patch({ recording: false });
    h.core.prepare.kickSwitch();
    await run;
    expect(h.store.state.prepare.phase).toBe('prepared');
    expect(embed.mute).toHaveBeenCalledTimes(1);
  });
});

/** The service answering a file's whole journey, each call open to change. */
function serviceAnswers(status: SongStatus = karaokeStatus()) {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(true);
  return {
    upload: vi.spyOn(ServiceClient.prototype, 'uploadSong').mockImplementation(async () => status),
    poll: vi
      .spyOn(ServiceClient.prototype, 'pollSong')
      .mockResolvedValue({ kind: 'settled', status } as PollOutcome),
    stem: vi
      .spyOn(ServiceClient.prototype, 'fetchStem')
      .mockImplementation(async () => ({ bytes: new ArrayBuffer(8), gain: 0.8 })),
    reference: vi.spyOn(ServiceClient.prototype, 'fetchReference').mockResolvedValue(MELODY),
  };
}

describe('MixController', () => {
  /** A harness with a loaded song and the stems in, at a stem gain of 0.8. */
  function mixed(playing = false) {
    const h = withSong();
    if (playing) h.player.state = 'playing';
    h.core.mix.install({
      vocals: { vocals: true } as unknown as AudioBuffer,
      noVocals: { noVocals: true } as unknown as AudioBuffer,
      gain: 0.8,
    });
    return h;
  }
  /** The latest level set for each stem. */
  const levels = (h: ReturnType<typeof mixed>) => {
    const last = new Map<string, number>();
    for (const [id, level] of h.player.setStemGain.mock.calls as Array<[string, number]>) {
      last.set(id, level);
    }
    return Object.fromEntries(last);
  };

  it('adds the stems silent and makes Karaoke the mix', () => {
    const h = mixed();
    const added = h.player.addStem.mock.calls.map(([id, , offset, level]) => [id, offset, level]);
    expect(added).toEqual([
      ['no_vocals', 0, 0],
      ['vocals', 0, 0],
    ]);
    expect(h.store.state.mix).toEqual({ available: true, choice: 'karaoke', guideLevel: 0.5 });
    expect(levels(h)).toEqual({ original: 0, no_vocals: 1, vocals: 0 });
  });

  it('joins a song that is playing without touching its position', () => {
    const h = mixed(true);
    expect(h.player.calls).toEqual([]);
    // The original is told to fall only as the stems begin to sound.
    for (const call of h.player.setStemGain.mock.calls) expect(call[2]).toBe(0.03);
  });

  it('switches mix by gain alone: no restart, seek or stop', () => {
    const h = mixed(true);
    h.core.mix.setMix('original');
    expect(levels(h)).toEqual({ original: 0.8, no_vocals: 0, vocals: 0 });
    h.core.mix.setMix('guide');
    expect(levels(h)).toEqual({ original: 0, no_vocals: 1, vocals: 0.5 });
    h.core.mix.setMix('karaoke');
    expect(levels(h)).toEqual({ original: 0, no_vocals: 1, vocals: 0 });
    expect(h.store.state.mix.choice).toBe('karaoke');
    expect(h.player.calls).toEqual([]);
  });

  it('sets the guide level, remembers it and uses it only in the guide mix', () => {
    const h = mixed();
    h.core.mix.setGuideLevel(0.2);
    expect(loadSettings(h.settingsStore).guideLevel).toBe(0.2);
    expect(h.store.state.mix.guideLevel).toBe(0.2);
    expect(levels(h).vocals).toBe(0);
    h.core.mix.setMix('guide');
    expect(levels(h).vocals).toBe(0.2);
    h.core.mix.setGuideLevel(3);
    expect(levels(h).vocals).toBe(1);
    expect(loadSettings(h.settingsStore).guideLevel).toBe(1);
  });

  it('starts from the saved guide level', () => {
    const h = makeHarness({ guideLevel: 0.75 });
    expect(h.store.state.mix.guideLevel).toBe(0.75);
  });

  it('offers no mix before the stems are in', () => {
    const h = withSong();
    h.core.mix.setMix('karaoke');
    expect(h.store.state.mix).toMatchObject({ available: false, choice: 'original' });
    expect(h.player.setStemGain).not.toHaveBeenCalled();
  });

  it('takes the stems out and plays the original in full when another song takes over', () => {
    const h = mixed();
    h.core.mix.clear();
    expect(h.player.removeStem.mock.calls.map(([id]) => id)).toEqual(['vocals', 'no_vocals']);
    expect(h.store.state.mix).toMatchObject({ available: false, choice: 'original' });
    expect(levels(h).original).toBe(1);
  });

  it('lowers whichever stems are sounding while a take plays over the song', async () => {
    const h = mixed();
    await h.core.input.chooseInput('usb');
    await h.core.takes.toggleRecord();
    h.engine.t = 1;
    h.player.positionS = 1;
    h.tracker.emit({ t: 1, f0: 220, clarity: 0.95, rms: 0.2 });
    await h.core.takes.toggleRecord();
    await h.core.takes.playTake(h.store.state.takes[0].id);
    expect(levels(h)).toMatchObject({ original: 0, no_vocals: DUCKED_ORIGINAL_GAIN, vocals: 0, take: 1 });
    h.core.takes.stopTake();
    expect(levels(h)).toMatchObject({ original: 0, no_vocals: 1, vocals: 0 });
  });
});

describe('StemsController', () => {
  /** A file loaded through the song controller, which starts its track. */
  async function dropped(name = 'tune.mp3') {
    const h = makeHarness();
    const lane = fakeLane();
    h.core.lane = lane;
    await h.core.songs.loadSong(new File(['x'], name));
    return { h, lane };
  }
  /** Lets work that was queued behind a microtask or a zero timer finish. */
  const settleQueue = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('plays the file at once, sends it, and brings back the stems and the melody', async () => {
    const answers = serviceAnswers();
    const { h, lane } = await dropped();
    expect(h.store.state.player).toBe('ready');
    await vi.waitFor(() => expect(h.store.state.reference.phase).toBe('ready'));

    expect(answers.upload).toHaveBeenCalledTimes(1);
    expect(answers.upload.mock.calls[0][0].name).toBe('tune.mp3');
    expect(answers.stem.mock.calls.map(([id, stem]) => [id, stem])).toEqual([
      ['abc', 'vocals'],
      ['abc', 'no_vocals'],
    ]);
    expect(h.store.state.mix).toEqual({ available: true, choice: 'karaoke', guideLevel: 0.5 });
    expect(h.store.state.karaoke.phase).toBe('ready');
    expect(h.store.state.reference).toEqual({ phase: 'ready', notes: 2, message: '' });
    // The lane gets the melody in time order, with the unpitched regions.
    const drawn = lane.setReference.mock.calls.at(-1)?.[0];
    expect(drawn.notes).toEqual([
      { onsetS: 0, offsetS: 1, midi: 57 },
      { onsetS: 2, offsetS: 3, midi: 62 },
    ]);
    expect(drawn.unpitchedS).toEqual([[1, 2]]);
    expect(lane.fitRangeToReference).toHaveBeenCalled();
    expect(h.store.state.status.text).toContain('Karaoke track ready');
  });

  it('plays the stems at unity and the original at the gain the stems carry', async () => {
    serviceAnswers();
    const { h } = await dropped();
    await vi.waitFor(() => expect(h.store.state.mix.available).toBe(true));
    h.core.mix.setMix('original');
    const last = new Map(h.player.setStemGain.mock.calls.map(([id, level]) => [id, level]));
    expect(last.get('original')).toBe(0.8);
    expect(last.get('no_vocals')).toBe(0);
    expect(last.get('vocals')).toBe(0);
  });

  it('says what is missing and nothing else when the service is away, and tries again when it is back', async () => {
    const { h } = await dropped();
    await vi.waitFor(() => expect(h.store.state.karaoke.phase).toBe('unavailable'));
    expect(h.store.state.player).toBe('ready');
    expect(h.store.state.mix.available).toBe(false);
    expect(h.store.state.status.kind).toBe('info');

    const answers = serviceAnswers();
    h.core.stems.checkService();
    await vi.waitFor(() => expect(h.store.state.mix.available).toBe(true));
    expect(answers.upload).toHaveBeenCalledTimes(1);
  });

  it('shows the upload as it goes and then the steps of the service', async () => {
    const answers = serviceAnswers();
    let sent!: (status: SongStatus) => void;
    answers.upload.mockImplementation(async (_file, options) => {
      options?.onProgress?.(0.4);
      return new Promise<SongStatus>((resolve) => {
        sent = resolve;
      });
    });
    const { h } = await dropped();
    await vi.waitFor(() => expect(h.store.state.karaoke.phase).toBe('uploading'));
    expect(h.store.state.karaoke.uploadProgress).toBe(0.4);

    sent(karaokeStatus({ separation: stepOf('running'), reference: stepOf('queued') }));
    await vi.waitFor(() => expect(h.store.state.mix.available).toBe(true));
    expect(answers.poll.mock.calls[0][1]?.through).toBe('separation');
  });

  it('ends the older upload when a newer file loads, and lets nothing of it through', async () => {
    const answers = serviceAnswers();
    let release!: (status: SongStatus) => void;
    const signals: AbortSignal[] = [];
    answers.upload.mockImplementationOnce(async (_file, options) => {
      signals.push(options?.signal as AbortSignal);
      return new Promise<SongStatus>((resolve) => {
        release = resolve;
      });
    });
    const { h } = await dropped('old.mp3');
    await vi.waitFor(() => expect(h.store.state.karaoke.phase).toBe('uploading'));

    vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
    await h.core.songs.loadSong(new File(['y'], 'new.mp3'));
    expect(signals[0].aborted).toBe(true);
    release(karaokeStatus());
    await vi.waitFor(() => expect(h.store.state.karaoke.phase).toBe('unavailable'));
    await settleQueue();
    expect(h.store.state.mix.available).toBe(false);
    expect(answers.stem).not.toHaveBeenCalled();
    expect(h.store.state.song?.name).toBe('new.mp3');
  });

  it('drops stems that finish decoding after another song has taken over', async () => {
    serviceAnswers();
    const h = withSong();
    h.core.stems.follow(karaokeStatus());
    let finish!: () => void;
    h.player.decode.mockImplementation(
      () =>
        new Promise<AudioBuffer>((resolve) => {
          finish = () => resolve({} as AudioBuffer);
        }),
    );
    await vi.waitFor(() => expect(h.player.decode).toHaveBeenCalled());
    // Another file is dropped and loads; the stems of the first are not its own.
    await h.core.songs.loadSong(new File(['w'], 'last.mp3'));
    finish();
    await settleQueue();
    expect(h.player.addStem).not.toHaveBeenCalled();
    expect(h.store.state.mix.available).toBe(false);
  });

  it('says why the service did not separate the song, and keeps the song as it is', async () => {
    serviceAnswers(karaokeStatus({ separation: stepOf('skipped', { detail: 'Separation is not installed.' }) }));
    const { h } = await dropped();
    await vi.waitFor(() => expect(h.store.state.karaoke.phase).toBe('failed'));
    expect(h.store.state.karaoke.message).toBe('Separation is not installed.');
    expect(h.store.state.mix.available).toBe(false);
    expect(h.player.addStem).not.toHaveBeenCalled();
  });

  it("gives the service's error when separation fails", async () => {
    serviceAnswers(
      karaokeStatus({
        separation: stepOf('failed', { error: 'Separating the vocal failed: out of memory' }),
        reference: stepOf('queued'),
      }),
    );
    const { h } = await dropped();
    await vi.waitFor(() => expect(h.store.state.karaoke.phase).toBe('failed'));
    expect(h.store.state.karaoke.message).toBe('Separating the vocal failed: out of memory');
  });

  it("shows a skipped melody's reason and draws no targets", async () => {
    const answers = serviceAnswers(
      karaokeStatus({ reference: stepOf('skipped', { detail: 'No singing found in this track.' }) }),
    );
    const { h, lane } = await dropped();
    await vi.waitFor(() => expect(h.store.state.reference.phase).toBe('skipped'));
    expect(h.store.state.reference.message).toBe('No singing found in this track.');
    expect(answers.reference).not.toHaveBeenCalled();
    expect(h.store.state.mix.available).toBe(true);
    for (const [melody] of lane.setReference.mock.calls) expect(melody).toBeNull();
  });

  it('treats a melody the service no longer has as skipped, not as a failure of the song', async () => {
    const answers = serviceAnswers();
    answers.reference.mockRejectedValue(new ServiceError('not-fetched', 'x', 409));
    const { h } = await dropped();
    await vi.waitFor(() => expect(h.store.state.reference.phase).toBe('skipped'));
    expect(h.store.state.mix.available).toBe(true);
    expect(h.store.state.karaoke.phase).toBe('ready');
  });

  it("puts the service's refusal of a file in the panel and leaves the song alone", async () => {
    const answers = serviceAnswers();
    answers.upload.mockRejectedValue(new ServiceError('rejected', 'Unsupported audio file. Accepted: .mp3.', 415));
    const { h } = await dropped();
    await vi.waitFor(() => expect(h.store.state.karaoke.phase).toBe('failed'));
    expect(h.store.state.karaoke.message).toBe('Unsupported audio file. Accepted: .mp3.');
    expect(h.store.state.player).toBe('ready');
  });

  it('joins a song that is already playing without a restart', async () => {
    const answers = serviceAnswers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answers.stem.mockImplementation(async () => {
      await gate;
      return { bytes: new ArrayBuffer(8), gain: 0.8 };
    });
    const { h } = await dropped();
    h.core.playback.play();
    h.player.positionS = 12;
    release();
    await vi.waitFor(() => expect(h.store.state.mix.available).toBe(true));
    expect(h.player.calls).toEqual(['play']);
    expect(h.player.positionS).toBe(12);
  });

  it('follows a linked song from its status, with no upload', async () => {
    const answers = serviceAnswers();
    const h = withSong();
    h.core.lane = fakeLane();
    h.core.stems.follow(karaokeStatus({ separation: stepOf('running'), reference: stepOf('queued') }));
    await vi.waitFor(() => expect(h.store.state.reference.phase).toBe('ready'));
    expect(answers.upload).not.toHaveBeenCalled();
    expect(h.store.state.mix.choice).toBe('karaoke');
  });

  it('forgets the track, the melody and the panel when another song takes over', async () => {
    serviceAnswers();
    const { h, lane } = await dropped();
    await vi.waitFor(() => expect(h.store.state.reference.phase).toBe('ready'));
    h.core.stems.reset();
    expect(h.store.state.mix).toMatchObject({ available: false, choice: 'original' });
    expect(h.store.state.reference.phase).toBe('none');
    expect(h.store.state.karaoke.phase).toBe('none');
    expect(lane.setReference).toHaveBeenLastCalledWith(null);
  });
});

describe('LatencyController calibration', () => {
  async function ready(saved?: Record<string, unknown>) {
    const h = makeHarness(saved);
    h.player.setSong(songInfo());
    await h.core.input.chooseInput('usb');
    return h;
  }

  it('stores the measured latency for the device pair and reports it', async () => {
    const h = await ready();
    hoisted.measureLatency.mockResolvedValue(goodResult(0.12, 0.9));
    await h.core.latency.calibrate();
    expect(h.store.state.latencyS).toBe(0.12);
    expect(loadSettings(h.settingsStore).latencyByDevicePair).toEqual({ [latencyKey(null, 'usb')]: 0.12 });
    expect(h.store.state.calibrating).toBe(false);
    expect(h.store.state.status).toEqual({
      text: 'Latency 120 ms (trials 120, 121 ms; confidence 0.90)',
      kind: 'info',
    });
  });

  it('warns when the confidence is low but still keeps the number', async () => {
    const h = await ready();
    hoisted.measureLatency.mockResolvedValue(goodResult(0.2, 0.4));
    await h.core.latency.calibrate();
    expect(h.store.state.latencyS).toBe(0.2);
    expect(h.store.state.status.kind).toBe('warn');
    expect(h.store.state.status.text).toContain('Confidence is low');
  });

  it('shows the room\'s refusal as a warning and changes nothing', async () => {
    const h = await ready();
    hoisted.measureLatency.mockRejectedValue(new CalibrationError('not-heard', 'The chirp was not heard.'));
    await h.core.latency.calibrate();
    expect(h.store.state.latencyS).toBeNull();
    expect(h.store.state.status).toEqual({ text: 'The chirp was not heard.', kind: 'warn' });
    expect(h.store.state.calibrating).toBe(false);
  });

  it('shows an audio failure as an error', async () => {
    const h = await ready();
    hoisted.measureLatency.mockRejectedValue(new Error('The audio clock stopped.'));
    await h.core.latency.calibrate();
    expect(h.store.state.status).toEqual({ text: 'The audio clock stopped.', kind: 'error' });
  });

  it('pauses a playing song for the run and resumes it afterwards', async () => {
    const h = await ready();
    h.core.playback.play();
    hoisted.measureLatency.mockImplementation(async () => {
      expect(h.store.state.calibrating).toBe(true);
      expect(h.player.state).toBe('paused');
      return goodResult();
    });
    await h.core.latency.calibrate();
    expect(h.player.state).toBe('playing');
  });

  it('needs a mic, and says which step is missing', async () => {
    const h = makeHarness();
    h.player.setSong(songInfo());
    await h.core.latency.calibrate();
    expect(h.store.state.status).toEqual({ text: 'Pick a microphone first.', kind: 'warn' });
    expect(hoisted.measureLatency).not.toHaveBeenCalled();
  });

  it('measures speaker mode on a raw mic and puts the saved mode back', async () => {
    const h = await ready({ monitor: 'speakers' });
    hoisted.measureLatency.mockResolvedValue(goodResult());
    await h.core.latency.calibrate();
    const modes = h.mic.open.mock.calls.map((call) => (call as unknown[])[2]);
    expect(modes).toEqual(['speakers', 'headphones', 'speakers']);
    expect(h.store.state.input.requestedAec).toBe(true);
    expect(h.store.state.latencyS).toBe(0.12);
  });
});
