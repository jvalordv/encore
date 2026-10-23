/**
 * End-to-end proof of the Phase 1 solo loop in real Chromium, against the
 * production bundle: shell and skins, loading a song, transport, the live
 * pitch tracker on a fake microphone, recording a take, playing it back,
 * calibration (the failure path, then a loopback of known delay) and speaker
 * mode (the mic reopened with echo cancellation, and back). It is the only
 * test that runs the audio worklets and Web Audio for real. The tests share
 * one page and run in order, each building on the state the last left behind;
 * the page is driven through `window.encore` (see src/main.ts) and the
 * data-testid hooks in index.html. Any uncaught page error fails the test
 * that was running when it happened.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { AppState } from '../src/app/state';
import { decodeWav } from '../src/audio/wav';
import { PORT, SONG_FILE, SONG_SECONDS } from './fixtures';

test.describe.configure({ mode: 'serial' });

/** Pitch of the fake microphone's tone. */
const MIC_HZ = 440;
/** Share of a frame's pitch it may be off by and still count as on target. */
const PITCH_TOLERANCE = 0.02;
/** The message measureLatency throws when the mic never hears the chirp. */
const NOT_HEARD =
  /Chirp not heard\. Mic heard [+-]?\d+ dB over its noise floor; needs about \+6 dB/;

let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

/** A pitch frame as the page keeps it. */
interface Frame {
  t: number;
  f0: number;
  clarity: number;
  rms: number;
}

/** What the test reads back from a stored take. */
interface StoredTake {
  id: string;
  durationS: number;
  latencyS: number;
  sampleRate: number;
  startedAtSongS: number;
  frames: Frame[];
  wavBase64: string;
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    baseURL: `http://localhost:${PORT}`,
    permissions: ['microphone'],
  });
  // The page links Google Fonts; answering with an empty sheet keeps the run
  // offline-safe and free of network noise. Every font stack has a fallback.
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
  });
  await page.goto('/');
  await page.waitForFunction(() => window.encore !== undefined);
});

test.afterEach(() => {
  expect(pageErrors, 'page errors').toEqual([]);
});

test.afterAll(async () => {
  await context.close();
});

/** A copy of the app state as the page holds it right now. */
async function appState(): Promise<AppState> {
  return page.evaluate(() => JSON.parse(JSON.stringify(window.encore!.store.state)) as AppState);
}

/** Loads the first stored take out of IndexedDB, WAV included, as base64. */
async function readStoredTakes(): Promise<StoredTake[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('encore');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const request = db.transaction('takes').objectStore('takes').getAll();
      request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const out: StoredTake[] = [];
    for (const r of records) {
      const wav = r.wav as Blob;
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(wav);
      });
      out.push({
        id: r.id as string,
        durationS: r.durationS as number,
        latencyS: r.latencyS as number,
        sampleRate: r.sampleRate as number,
        startedAtSongS: r.startedAtSongS as number,
        frames: r.frames as Frame[],
        wavBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      });
    }
    return out;
  });
}

test('1. the shell loads and the skin choice survives a reload', async () => {
  await expect(page.locator('#skin-switcher option')).toHaveCount(3);
  await page.selectOption('#skin-switcher', 'dreamhouse');
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'dreamhouse');

  await page.reload();
  await page.waitForFunction(() => window.encore !== undefined);
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'dreamhouse');
  await expect(page.locator('#skin-switcher')).toHaveValue('dreamhouse');
});

test('2. a dropped song decodes to the right length', async () => {
  await page.getByTestId('song-input').setInputFiles(SONG_FILE);
  await page.waitForFunction(() => window.encore!.store.state.player === 'ready');
  const loaded = await page.evaluate(() => {
    const { song, durationS } = window.encore!.store.state;
    return { durationS, hash: song?.hash ?? '', name: song?.name ?? '' };
  });
  expect(Math.abs(loaded.durationS - SONG_SECONDS)).toBeLessThan(0.05);
  expect(loaded.name).toBe('song.wav');
  expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId('song-title')).toHaveText('song.wav');
  await expect(page.getByTestId('play')).toBeEnabled();
});

test('3. play advances the playhead at real speed and pause holds it', async () => {
  await page.getByTestId('play').click();
  await page.waitForTimeout(1000);
  const playing = await page.evaluate(() => ({
    positionS: window.encore!.store.state.positionS,
    player: window.encore!.store.state.player,
    context: window.encore!.session.parts!.engine.context.state,
  }));
  expect(playing.player).toBe('playing');
  expect(playing.context).toBe('running');
  expect(playing.positionS).toBeGreaterThan(0.8);
  // A clock running fast would break every timing score; 1 s of wall time
  // must not read as much more than 1 s of song.
  expect(playing.positionS).toBeLessThan(1.6);

  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
  const first = (await appState()).positionS;
  await page.waitForTimeout(500);
  const second = (await appState()).positionS;
  expect(second).toBe(first);
});

test('4. the fake microphone is tracked at 440 Hz from the built worklet', async () => {
  const options = await page.$$eval('#input-select option', (list) =>
    (list as HTMLOptionElement[]).map((o) => ({ value: o.value, text: o.textContent ?? '' })),
  );
  // A named device rather than "default" so the deviceId path is the one run.
  const named = options.filter((o) => !o.value.startsWith('@') && o.value !== 'default');
  const fake = named.find((o) => /fake/i.test(o.text));
  test.info().annotations.push({
    type: 'input options',
    description: JSON.stringify(options),
  });
  // Without an enumerated fake device the system default is the same device.
  await page.selectOption('#input-select', fake ? fake.value : '@default');

  await page.waitForFunction(
    () => {
      const s = window.encore!.store.state;
      return s.tracker === 'running' && s.framesPerSecond > 50;
    },
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    () => {
      const f = window.encore!.store.state.lastFrame;
      return f !== null && Math.abs(f.f0 - 440) / 440 < 0.02 && f.clarity >= 0.9;
    },
    undefined,
    { timeout: 10_000 },
  );

  // The meter reads high while the first queued frames drain, so judge the
  // rate only after it has had a window or two to settle.
  await page.waitForTimeout(2000);
  const { input, framesPerSecond: fps } = await appState();
  expect(input.open).toBe(true);
  // The constraints must really have switched the browser's voice processing
  // off; it flattens dynamics and smears pitch onsets.
  expect(input.processing).toEqual({ aec: false, ns: false, agc: false });
  expect(fps).toBeGreaterThan(85);
  expect(fps).toBeLessThan(115);
  await expect(page.getByTestId('pitch-note')).toHaveText('A4');
});

test('5. recording while playing stores a take with the sung pitch', async () => {
  await page.getByTestId('stop').click();
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await page.waitForTimeout(200);

  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording === true);
  await page.waitForTimeout(1500);
  await page.getByTestId('record').click();
  await expect(page.getByTestId('take-item')).toHaveCount(1);
  await page.getByTestId('play').click();

  const summary = (await appState()).takes;
  expect(summary).toHaveLength(1);
  expect(summary[0].durationS).toBeGreaterThan(1);
  expect(summary[0].durationS).toBeLessThan(3);

  const takes = await readStoredTakes();
  expect(takes).toHaveLength(1);
  const [take] = takes;
  expect(take.sampleRate).toBe(48000);
  // The song was at 0 when playback began, so the take starts a fraction of a
  // second in and ends that long after.
  expect(take.startedAtSongS).toBeGreaterThan(0.1);
  expect(take.startedAtSongS).toBeLessThan(1);

  // The live trace: about 100 frames a second for the length of the take, all
  // stamped on song time, nearly all voiced at the fake mic's pitch.
  const { frames } = take;
  expect(frames.length).toBeGreaterThan(take.durationS * 80);
  const onPitch = frames.filter((f) => f.f0 > 0 && Math.abs(f.f0 - MIC_HZ) / MIC_HZ < PITCH_TOLERANCE);
  expect(onPitch.length / frames.length).toBeGreaterThan(0.8);
  for (let i = 1; i < frames.length; i++) expect(frames[i].t).toBeGreaterThan(frames[i - 1].t);
  expect(frames[0].t).toBeGreaterThan(take.startedAtSongS - 0.2);
  expect(frames[frames.length - 1].t).toBeLessThan(take.startedAtSongS + take.durationS + 0.2);

  // The audio: a 16-bit WAV of the same tone at about half scale.
  const wav = decodeWav(
    Uint8Array.from(Buffer.from(take.wavBase64, 'base64')).buffer as ArrayBuffer,
  );
  expect(wav.sampleRate).toBe(48000);
  expect(Math.abs(wav.pcm.length / wav.sampleRate - take.durationS)).toBeLessThan(0.01);
  const mid = wav.pcm.subarray(Math.floor(wav.pcm.length * 0.2), Math.floor(wav.pcm.length * 0.8));
  let energy = 0;
  let crossings = 0;
  for (let i = 0; i < mid.length; i++) {
    energy += mid[i] * mid[i];
    if (i > 0 && mid[i - 1] < 0 && mid[i] >= 0) crossings++;
  }
  expect(Math.sqrt(energy / mid.length)).toBeGreaterThan(0.3);
  expect(Math.sqrt(energy / mid.length)).toBeLessThan(0.4);
  const hz = crossings / (mid.length / wav.sampleRate);
  expect(Math.abs(hz - MIC_HZ) / MIC_HZ).toBeLessThan(0.02);
});

test('6. a saved take plays back under the song and stops cleanly', async () => {
  await page.getByTestId('take-play').click();
  await page.waitForFunction(() => window.encore!.store.state.playingTakeId !== null);
  await page.waitForTimeout(600);
  const during = await page.evaluate(() => {
    const { player, positionS } = window.encore!.store.state;
    const stems = window.encore!.session.parts!.player.stemIds();
    return { player, positionS, stems };
  });
  expect(during.player).toBe('playing');
  expect(during.stems).toEqual(['original', 'take']);
  expect(during.positionS).toBeGreaterThan(0);

  await page.getByTestId('take-play').click();
  await page.waitForFunction(() => window.encore!.store.state.playingTakeId === null);
  const after = await page.evaluate(() => ({
    player: window.encore!.store.state.player,
    stems: window.encore!.session.parts!.player.stemIds(),
    original: window.encore!.session.parts!.player.stemGain('original'),
  }));
  expect(after.player).toBe('paused');
  expect(after.stems).toEqual(['original']);
  expect(after.original).toBe(1);

  // Pressing Record while a take plays hands over to the new take: the old
  // one stops, so it is not heard under the singer or drawn over the lane.
  await page.getByTestId('take-play').click();
  await page.waitForFunction(() => window.encore!.store.state.playingTakeId !== null);
  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording === true);
  const handover = await page.evaluate(() => ({
    playingTakeId: window.encore!.store.state.playingTakeId,
    stems: window.encore!.session.parts!.player.stemIds(),
    original: window.encore!.session.parts!.player.stemGain('original'),
  }));
  expect(handover.playingTakeId).toBeNull();
  expect(handover.stems).toEqual(['original']);
  expect(handover.original).toBe(1);
  await page.waitForTimeout(500);
  await page.getByTestId('record').click();
  await expect(page.getByTestId('take-item')).toHaveCount(2);
  await page.getByTestId('stop').click();
});

test('7. calibration with no echo fails with a message and does not crash', async () => {
  // The fake microphone plays the 440 Hz fixture, never the chirp, so the
  // level during the chirp is no higher than the level before it and the
  // documented "not heard" warning, with its measured levels, must appear.
  await page.getByTestId('calibrate').click();
  await page.waitForFunction(() => window.encore!.store.state.calibrating === true);
  await page.waitForFunction(() => window.encore!.store.state.calibrating === false, undefined, {
    timeout: 30_000,
  });
  const result = await page.evaluate(() => ({
    status: window.encore!.store.state.status,
    latencyS: window.encore!.store.state.latencyS,
    open: window.encore!.store.state.input.open,
    tracker: window.encore!.store.state.tracker,
  }));
  expect(result.status.text).toMatch(NOT_HEARD);
  expect(result.status.text).toContain('turn the speakers up or move the mic closer');
  // A room that did not answer is a warning, not an application error.
  expect(result.status.kind).toBe('warn');
  expect(result.latencyS).toBeNull();
  // The mic and tracker survive the failed run.
  expect(result.open).toBe(true);
  expect(result.tracker).toBe('running');
  await expect(page.getByTestId('calibrate')).toBeEnabled();
  await expect(page.getByTestId('status-text')).toHaveText(NOT_HEARD);
});

test('8. calibration against a loopback of known delay recovers it', async () => {
  const knownS = 0.087;
  // Route the chirp through a DelayNode and hand the measurer that node as the
  // "microphone", so the true round trip is known exactly and the real chirp,
  // capture worklet and context clock do the measuring.
  await page.evaluate((delayS) => {
    const { engine, mic } = window.encore!.session.parts!;
    const delay = engine.context.createDelay(1);
    delay.delayTime.value = delayS;
    engine.master.connect(delay);
    Object.defineProperty(mic, 'source', { configurable: true, get: () => delay });
  }, knownS);

  // The song is playing when Calibrate is pressed. It would be heard in the
  // loopback, so it must stand still for the chirps and carry on afterwards.
  await page.getByTestId('stop').click();
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await page.waitForTimeout(300);
  const before = await appState();
  await page.getByTestId('calibrate').click();
  await page.waitForFunction(() => window.encore!.store.state.calibrating === true);
  expect((await appState()).player).toBe('paused');
  await page.waitForFunction(() => window.encore!.store.state.calibrating === false, undefined, {
    timeout: 30_000,
  });
  const result = await appState();
  expect(result.status.kind).toBe('info');
  const shown = /^Latency 87 ms \(trials (\d+), (\d+), (\d+) ms; confidence (\d\.\d\d)\)$/.exec(
    result.status.text,
  );
  expect(shown, result.status.text).not.toBeNull();
  for (const ms of shown!.slice(1, 4)) expect(Math.abs(Number(ms) - 87)).toBeLessThanOrEqual(1);
  expect(Number(shown![4])).toBeGreaterThan(0.6);
  expect(result.latencyS).not.toBeNull();
  expect(Math.abs((result.latencyS ?? 0) - knownS)).toBeLessThan(0.001);
  test.info().annotations.push({ type: 'measured latency', description: `${result.latencyS}` });
  test.info().annotations.push({ type: 'status', description: result.status.text });
  await expect(page.getByTestId('latency-input')).toHaveValue('87');

  // The song picked up where it stood instead of running on through the run.
  expect(result.player).toBe('playing');
  expect(Math.abs(result.positionS - before.positionS)).toBeLessThan(0.5);
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');

  // The value survives a reload, filed under the device pair it was heard on.
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').latencyByDevicePair as Record<string, number>,
  );
  expect(Object.values(saved)).toHaveLength(1);
  expect(Math.abs(Object.values(saved)[0] - knownS)).toBeLessThan(0.001);

  await page.evaluate(() => {
    const { engine, mic } = window.encore!.session.parts!;
    const source = mic.source as unknown as AudioNode;
    engine.master.disconnect(source);
    delete (mic as { source?: unknown }).source;
  });
});

test('9. a pitch frame lands on song time minus the latency, once', async () => {
  const latencyS = 0.25;
  const toneHz = 330;
  // A silent oscillator stands in for the mic on the tracker, then gets loud
  // at a context time whose song time is known. The first voiced frame of the
  // take must sit at that song time minus the latency, give or take the
  // tracker's window: not at the onset itself, and not a latency earlier still.
  const onsetSongS = await page.evaluate(
    async ({ latency, hz }) => {
      const session = window.encore!.session;
      const { engine, player, tracker, mic } = session.parts!;
      const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      session.setLatency(latency);
      session.stop();
      const osc = engine.context.createOscillator();
      osc.frequency.value = hz;
      const gain = engine.context.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      osc.start();
      tracker.connect(gain);
      session.play();
      await sleep(200);
      await session.toggleRecord();
      const onsetContextS = engine.now() + 0.6;
      gain.gain.setValueAtTime(0.5, onsetContextS);
      const onsetSong = player.songTimeAtContext(onsetContextS);
      await sleep(1400);
      await session.toggleRecord();
      session.pause();
      tracker.connect(mic.source!);
      osc.stop();
      return onsetSong;
    },
    { latency: latencyS, hz: toneHz },
  );
  expect(onsetSongS).not.toBeNull();

  await expect(page.getByTestId('take-item')).toHaveCount(3);
  const take = (await readStoredTakes()).find((t) => t.latencyS === latencyS)!;
  expect(take).toBeDefined();
  const voiced = take.frames.filter((f) => f.f0 > 0);
  expect(voiced.length).toBeGreaterThan(50);
  for (const f of voiced) expect(Math.abs(f.f0 - toneHz) / toneHz).toBeLessThan(PITCH_TOLERANCE);
  // Frames before the onset are digital silence and must read as unvoiced.
  expect(take.frames.some((f) => f.f0 === 0 && f.t < voiced[0].t)).toBe(true);

  const expectedS = (onsetSongS as number) - latencyS;
  const offsetS = voiced[0].t - expectedS;
  test.info().annotations.push({ type: 'first voiced frame vs onset - latency', description: `${offsetS}` });
  expect(offsetS).toBeGreaterThan(-0.04);
  expect(offsetS).toBeLessThan(0.03);
});

test('10. A, B and the keyboard loop a passage and the song ends cleanly', async () => {
  const positions = async (count: number, everyMs: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      await page.waitForTimeout(everyMs);
      out.push((await appState()).positionS);
    }
    return out;
  };
  await page.getByTestId('stop').click();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(300);
  expect((await appState()).positionS).toBeGreaterThan(1.2);

  await page.keyboard.press('[');
  await page.waitForTimeout(600);
  await page.keyboard.press(']');
  const loop = (await appState()).loop;
  expect(loop).not.toBeNull();
  expect(loop!.endS - loop!.startS).toBeGreaterThan(0.4);
  expect(loop!.endS - loop!.startS).toBeLessThan(1.2);

  // Pressing B puts the playhead on the loop's end; the loop must still take
  // hold and keep the playhead inside it from then on.
  const inside = await positions(15, 100);
  for (const p of inside.slice(3)) {
    expect(p).toBeGreaterThanOrEqual(loop!.startS - 0.05);
    expect(p).toBeLessThanOrEqual(loop!.endS + 0.05);
  }
  expect(Math.max(...inside) - Math.min(...inside)).toBeGreaterThan(0.2);

  await page.keyboard.press('l');
  await page.waitForFunction(() => window.encore!.store.state.loop === null);
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused', undefined, {
    timeout: 10_000,
  });
  const end = await appState();
  expect(end.positionS).toBeCloseTo(SONG_SECONDS, 1);
});

test('11. a browser missing AudioWorklet or the mic API degrades with a message', async ({ browser }) => {
  const cases = [
    {
      name: 'no AudioWorklet',
      hide: () => void delete (window as { AudioWorkletNode?: unknown }).AudioWorkletNode,
      status: /no AudioWorklet/,
      tracker: 'unsupported',
    },
    {
      name: 'no getUserMedia',
      hide: () => Object.defineProperty(navigator, 'mediaDevices', { value: undefined }),
      status: /cannot capture a microphone/,
      tracker: 'idle',
    },
  ];
  for (const { name, hide, status, tracker } of cases) {
    const other = await browser.newContext({ baseURL: `http://localhost:${PORT}`, permissions: ['microphone'] });
    await other.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
      route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
    );
    await other.addInitScript(`(${hide.toString()})()`);
    const errors: string[] = [];
    const bare = await other.newPage();
    bare.on('pageerror', (error) => errors.push(error.message));
    await bare.goto('/');
    await bare.waitForFunction(() => window.encore !== undefined);
    await bare.getByTestId('song-input').setInputFiles(SONG_FILE);
    await bare.waitForFunction(() => window.encore!.store.state.player === 'ready');
    await bare.getByTestId('mic-toggle').click();
    await bare.waitForFunction(() => window.encore!.store.state.status.text !== 'Opening the microphone…');
    const after = await bare.evaluate(() => ({
      status: window.encore!.store.state.status.text,
      tracker: window.encore!.store.state.tracker,
    }));
    expect(after.status, name).toMatch(status);
    expect(after.tracker, name).toBe(tracker);
    // Playback never needed the mic or the worklet, so it must still work.
    await bare.getByTestId('play').click();
    await bare.waitForFunction(() => window.encore!.store.state.positionS > 0.2);
    expect(errors, name).toEqual([]);
    await other.close();
  }
});

/** The constraints getUserMedia was called with, recorded by watchMicOpens. */
interface OpenedAudio {
  audio: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean };
}

/** Starts recording every getUserMedia call the page makes from now on. */
async function watchMicOpens(): Promise<void> {
  await page.evaluate(() => {
    const devices = navigator.mediaDevices;
    const original = devices.getUserMedia.bind(devices);
    const calls: unknown[] = [];
    (window as unknown as { micOpens: unknown[] }).micOpens = calls;
    devices.getUserMedia = (constraints) => {
      calls.push(JSON.parse(JSON.stringify(constraints)));
      return original(constraints);
    };
  });
}

/** The getUserMedia calls seen since watchMicOpens; stops watching. */
async function micOpens(): Promise<OpenedAudio[]> {
  return page.evaluate(() => {
    delete (navigator.mediaDevices as { getUserMedia?: unknown }).getUserMedia;
    return (window as unknown as { micOpens: OpenedAudio[] }).micOpens;
  });
}

/** Id of the live mic track, to tell a reopened mic from the old one. */
async function micTrackId(): Promise<string | undefined> {
  return page.evaluate(() => window.encore!.session.parts!.mic.stream?.getAudioTracks()[0]?.id);
}

/** Waits for the tracker to report the fake microphone's 440 Hz again. */
async function expectTracking440(): Promise<void> {
  await page.waitForFunction(
    () => {
      const { tracker, framesPerSecond, lastFrame: f } = window.encore!.store.state;
      return (
        tracker === 'running' &&
        framesPerSecond > 50 &&
        f !== null &&
        Math.abs(f.f0 - 440) / 440 < 0.02 &&
        f.clarity >= 0.9
      );
    },
    undefined,
    { timeout: 15_000 },
  );
}

test('12. speaker mode reopens the mic with echo cancellation and switching back restores raw input', async () => {
  await page.getByTestId('stop').click();
  const before = await appState();
  expect(before.input.open).toBe(true);
  expect(before.input.monitor).toBe('headphones');
  expect(before.input.requestedAec).toBe(false);
  const headphones = page.getByTestId('monitor-headphones');
  const speakers = page.getByTestId('monitor-speakers');
  await expect(headphones).toHaveAttribute('aria-pressed', 'true');
  await expect(speakers).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('monitor-mode')).toBeVisible();
  await expect(page.getByTestId('mic-processing')).toHaveText('Raw input: processing off');
  const oldTrack = await micTrackId();
  expect(oldTrack).toBeDefined();
  // Choices made before the switch must still stand after it.
  const picked = await page.locator('#input-select').inputValue();
  await page.evaluate(() => window.encore!.session.setClarity(0.83));

  await watchMicOpens();
  await speakers.click();
  await page.waitForFunction(() => window.encore!.store.state.input.requestedAec === true, undefined, {
    timeout: 15_000,
  });
  await expectTracking440();
  // The meter reads the new analyser, so the old one is not what is shown.
  await page.waitForFunction(() => window.encore!.store.state.input.level > 0.1);

  // A new stream was opened, with echo cancellation asked for and the other
  // two filters still off; the old one was let go.
  const opened = await micOpens();
  expect(opened).toHaveLength(1);
  expect(opened[0].audio).toMatchObject({
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
  });
  expect(await micTrackId()).not.toBe(oldTrack);

  const speaker = await appState();
  expect(speaker.input.monitor).toBe('speakers');
  expect(speaker.input.requestedAec).toBe(true);
  expect(speaker.input.open).toBe(true);
  expect(speaker.tracker).toBe('running');
  // The device selection and the latency key are what they were.
  expect(speaker.input.deviceId).toBe(before.input.deviceId);
  await expect(page.locator('#input-select')).toHaveValue(picked);
  expect(
    await page.evaluate(() => window.encore!.session.parts!.tracker.clarityThreshold),
  ).toBe(0.83);
  await expect(speakers).toHaveAttribute('aria-pressed', 'true');
  await expect(headphones).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('status-text')).toContainText('Speaker mode');
  await expect(page.getByTestId('mic-processing')).toContainText('Speaker mode');
  // Whether the fake device honours the request is its own business: when it
  // says, the status line must agree with what it said.
  const { aec, ns, agc } = speaker.input.processing;
  test.info().annotations.push({ type: 'speaker processing', description: JSON.stringify({ aec, ns, agc }) });
  if (aec === true) {
    await expect(page.getByTestId('status-text')).toContainText('echo cancellation on');
    expect(speaker.status.kind).toBe(ns || agc ? 'warn' : 'info');
  } else if (aec === false) {
    await expect(page.getByTestId('status-text')).toContainText('kept echo cancellation off');
    expect(speaker.status.kind).toBe('warn');
  }
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('encore.settings') ?? '{}').monitor as string,
  );
  expect(saved).toBe('speakers');

  // A recording in progress must not lose its stream to a mode switch.
  await page.getByTestId('record').click();
  await page.waitForFunction(() => window.encore!.store.state.recording === true);
  await expect(headphones).toBeDisabled();
  const recordingTrack = await micTrackId();
  await page.evaluate(() => window.encore!.session.setMonitor('headphones'));
  const refused = await appState();
  expect(refused.recording).toBe(true);
  expect(refused.input.monitor).toBe('speakers');
  expect(refused.input.requestedAec).toBe(true);
  expect(refused.status.kind).toBe('warn');
  expect(refused.status.text).toBe('Stop recording before changing the monitor mode.');
  expect(await micTrackId()).toBe(recordingTrack);
  await page.waitForTimeout(500);
  await page.getByTestId('record').click();
  await expect(page.getByTestId('take-item')).toHaveCount(4);
  await page.getByTestId('stop').click();

  // And back: raw input, same device, still tracking.
  await headphones.click();
  await page.waitForFunction(() => window.encore!.store.state.input.requestedAec === false, undefined, {
    timeout: 15_000,
  });
  await expectTracking440();
  const back = await appState();
  expect(back.input.monitor).toBe('headphones');
  expect(back.input.processing).toEqual({ aec: false, ns: false, agc: false });
  expect(back.input.deviceId).toBe(before.input.deviceId);
  await expect(page.locator('#input-select')).toHaveValue(picked);
  expect(
    await page.evaluate(() => window.encore!.session.parts!.tracker.clarityThreshold),
  ).toBe(0.83);
  await page.evaluate(() => window.encore!.session.setClarity(0.9));
  await expect(headphones).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('status-text')).toContainText('Raw input');
  await expect(page.getByTestId('mic-processing')).toHaveText('Raw input: processing off');
});

test('13. calibrating in speaker mode borrows a raw mic and puts echo cancellation back', async () => {
  await page.getByTestId('monitor-speakers').click();
  await page.waitForFunction(() => window.encore!.store.state.input.requestedAec === true, undefined, {
    timeout: 15_000,
  });
  // A song that is playing stands still for the run and carries on after it.
  await page.getByTestId('stop').click();
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'playing');
  await watchMicOpens();
  await page.getByTestId('calibrate').click();
  // Echo cancellation would remove the chirp, so the run is on a raw mic.
  await page.waitForFunction(
    () => {
      const s = window.encore!.store.state;
      return s.calibrating && s.input.open && s.input.requestedAec === false;
    },
    undefined,
    { timeout: 15_000 },
  );
  const during = await appState();
  expect(during.input.monitor).toBe('speakers');
  expect(during.player).toBe('paused');
  await page.waitForFunction(() => window.encore!.store.state.calibrating === false, undefined, {
    timeout: 30_000,
  });

  // The fake microphone never hears the chirp, so the run ends in the usual
  // warning; what matters is that speaker mode is back afterwards.
  const after = await appState();
  expect(after.status.text).toMatch(NOT_HEARD);
  expect(after.status.kind).toBe('warn');
  expect(after.input.open).toBe(true);
  expect(after.input.monitor).toBe('speakers');
  expect(after.input.requestedAec).toBe(true);
  expect(after.tracker).toBe('running');
  expect(after.player).toBe('playing');
  await page.getByTestId('play').click();
  await page.waitForFunction(() => window.encore!.store.state.player === 'paused');
  const opened = await micOpens();
  expect(opened.map((o) => o.audio.echoCancellation)).toEqual([false, true]);
  await expectTracking440();
  await expect(page.getByTestId('calibrate')).toBeEnabled();

  await page.getByTestId('monitor-headphones').click();
  await page.waitForFunction(() => window.encore!.store.state.input.requestedAec === false, undefined, {
    timeout: 15_000,
  });
  expect((await appState()).input.monitor).toBe('headphones');
});
