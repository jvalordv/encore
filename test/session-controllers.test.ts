/**
 * Unit tests for the session controllers on fake parts (test/session-harness):
 * the frame bus, loading a song, play/pause/seek/loop, the mic and the frames
 * it puts on the bus, recording a take and replaying it, the switch to
 * prepared audio, and a calibration result. The real Web Audio paths belong to
 * the end-to-end run; here the transport, mic, tracker, recorder and clock
 * only remember what they were asked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameBus } from '../src/app/session/frame-bus';
import type { SingerFrame } from '../src/app/session/frame-bus';
import { DUCKED_ORIGINAL_GAIN } from '../src/app/session/takes';
import { loadSettings } from '../src/app/settings';
import { CalibrationError, latencyKey } from '../src/audio/latency';
import type { LatencyResult } from '../src/audio/latency';
import type { YouTubeTransport } from '../src/audio/youtube-transport';
import { ServiceClient } from '../src/service/client';
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
  const audio = { kind: 'audio', bytes: new ArrayBuffer(8), status: {} };

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
