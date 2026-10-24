/**
 * Tests for the lazy IFrame API loader against a fake page: nothing is
 * fetched until a link is used, concurrent callers share one script, a script
 * error or a timeout gives the plain "Could not reach YouTube" message and
 * leaves the loader able to try again, and a callback another script had
 * registered is still called. No browser, no network.
 */
import { describe, expect, it, vi } from 'vitest';
import { API_TIMEOUT_MS, API_UNREACHABLE, IFRAME_API_URL, YT_STATE, loadYouTubeApi } from '../src/audio/youtube-api';
import type { ApiEnv, ApiScope, YouTubeApi } from '../src/audio/youtube-api';

/** A fake page: its globals, the scripts added to it and its pending timers. */
function fakePage() {
  const scope: ApiScope = {};
  const scripts: Array<{ src: string; fail: () => void; removed: boolean }> = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let nextTimer = 1;
  const env: ApiEnv = {
    scope,
    addScript(src, onError) {
      const script = { src, fail: onError, removed: false };
      scripts.push(script);
      return () => {
        script.removed = true;
      };
    },
    setTimeout(callback, ms) {
      const id = nextTimer++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  /** Plays the API script: defines YT.Player and calls the page's callback. */
  const runApiScript = (): YouTubeApi => {
    const api = { Player: class {} } as unknown as YouTubeApi;
    scope.YT = api;
    scope.onYouTubeIframeAPIReady?.();
    return api;
  };
  return { env, scope, scripts, timers, runApiScript };
}

describe('loadYouTubeApi', () => {
  it('adds no script until it is called', () => {
    const { scripts } = fakePage();
    expect(scripts).toHaveLength(0);
  });

  it('adds the documented script and resolves with YT once the page callback fires', async () => {
    const { env, scripts, runApiScript, timers } = fakePage();
    const loading = loadYouTubeApi(env);
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe('https://www.youtube.com/iframe_api');
    expect(scripts[0].src).toBe(IFRAME_API_URL);
    expect(timers.size).toBe(1);
    const api = runApiScript();
    await expect(loading).resolves.toBe(api);
    // The timeout is cancelled once the API is up.
    expect(timers.size).toBe(0);
  });

  it('gives concurrent callers the same promise and one script', async () => {
    const { env, scripts, runApiScript } = fakePage();
    const a = loadYouTubeApi(env);
    const b = loadYouTubeApi(env);
    expect(b).toBe(a);
    expect(scripts).toHaveLength(1);
    runApiScript();
    await a;
  });

  it('resolves at once, with no script, when the API is already on the page', async () => {
    const { env, scope, scripts } = fakePage();
    const api = { Player: class {} } as unknown as YouTubeApi;
    scope.YT = api;
    await expect(loadYouTubeApi(env)).resolves.toBe(api);
    expect(scripts).toHaveLength(0);
  });

  it('serves later calls from the loaded API without another script', async () => {
    const { env, scripts, runApiScript } = fakePage();
    const first = loadYouTubeApi(env);
    runApiScript();
    const api = await first;
    await expect(loadYouTubeApi(env)).resolves.toBe(api);
    expect(scripts).toHaveLength(1);
  });

  it('rejects with the plain message when the script cannot load, then tries again', async () => {
    const { env, scope, scripts, runApiScript, timers } = fakePage();
    const first = loadYouTubeApi(env);
    scripts[0].fail();
    await expect(first).rejects.toThrow(API_UNREACHABLE);
    expect(API_UNREACHABLE).toBe('Could not reach YouTube. Check the connection.');
    expect(scripts[0].removed).toBe(true);
    expect(timers.size).toBe(0);
    expect(scope.onYouTubeIframeAPIReady).toBeUndefined();

    // The connection is back: a new attempt adds a new script and works.
    const second = loadYouTubeApi(env);
    expect(scripts).toHaveLength(2);
    const api = runApiScript();
    await expect(second).resolves.toBe(api);
  });

  it('rejects after the timeout and removes the script', async () => {
    const { env, scripts, timers } = fakePage();
    const loading = loadYouTubeApi(env);
    const [timer] = [...timers.values()];
    expect(timer.ms).toBe(API_TIMEOUT_MS);
    timer.callback();
    await expect(loading).rejects.toThrow(API_UNREACHABLE);
    expect(scripts[0].removed).toBe(true);
  });

  it('settles once: an error after the timeout, or a ready after an error, changes nothing', async () => {
    const { env, scripts, timers, runApiScript } = fakePage();
    const loading = loadYouTubeApi(env);
    const [timer] = [...timers.values()];
    timer.callback();
    scripts[0].fail();
    await expect(loading).rejects.toThrow(API_UNREACHABLE);
    // A slow script that finally runs finds nobody listening; no throw.
    expect(() => runApiScript()).not.toThrow();
  });

  it('still calls a callback another script registered first', async () => {
    const { env, scope, runApiScript } = fakePage();
    const earlier = vi.fn();
    scope.onYouTubeIframeAPIReady = earlier;
    const loading = loadYouTubeApi(env);
    runApiScript();
    await loading;
    expect(earlier).toHaveBeenCalledTimes(1);
  });

  it('rejects if the ready callback fires but YT.Player never appeared', async () => {
    const { env, scope } = fakePage();
    const loading = loadYouTubeApi(env);
    scope.onYouTubeIframeAPIReady?.();
    await expect(loading).rejects.toThrow(API_UNREACHABLE);
  });

  it('keeps separate pages apart', async () => {
    const one = fakePage();
    const two = fakePage();
    const a = loadYouTubeApi(one.env);
    const b = loadYouTubeApi(two.env);
    expect(b).not.toBe(a);
    expect(one.scripts).toHaveLength(1);
    expect(two.scripts).toHaveLength(1);
    one.runApiScript();
    two.runApiScript();
    await Promise.all([a, b]);
  });
});

describe('YT_STATE', () => {
  it('uses the API\'s own numbering', () => {
    expect(YT_STATE).toEqual({ UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 });
  });
});
