/**
 * What the end-to-end specs that play a YouTube video share, with YouTube
 * itself replaced. `FAKE_IFRAME_API` is the script Playwright serves in place
 * of Google's IFrame API: its `YT.Player` replaces its target with a real
 * iframe, keeps a clock that runs while it "plays", fires the events the real
 * one does, records every call it is given, and can be told from the test to
 * start an ad or raise an error. The functions below read it, drive it and the
 * page, each taking the Page they act on so more than one spec can use them.
 */
import type { Page } from '@playwright/test';
import type { AppState } from '../src/app/state';

/** What the fake player records about itself, as the page exposes it. */
export interface FakeHandle {
  videoId: string;
  destroyed: boolean;
  muted: boolean;
  calls: string[];
  options: {
    host: string;
    videoId: string;
    width: string;
    height: string;
    playerVars: Record<string, string | number>;
  };
}

/**
 * The fake IFrame API. `__CONFIG__` becomes the title, the length, the delay
 * before ready and the ids that cannot be embedded. It mirrors the real one
 * where that matters here: a cued video does not play until asked (but
 * seeking it does play it), playVideo goes through buffering, the clock
 * extrapolates while playing, mute and unMute only flip a flag, and during an
 * ad the player reports the ad's id, length and time instead of the video's.
 */
export const FAKE_IFRAME_API = `(function () {
  var STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  var registry = (window.__yt = { players: [], config: __CONFIG__ });
  function FakePlayer(target, options) {
    var self = this;
    this.options = options;
    this.videoId = options.videoId;
    this.state = STATE.UNSTARTED;
    this.baseS = Number((options.playerVars && options.playerVars.start) || 0);
    this.startedAtMs = 0;
    this.rate = 1;
    this.destroyed = false;
    this.muted = false;
    this.ad = null;
    this.calls = [];
    this.events = options.events || {};
    var iframe = document.createElement('iframe');
    iframe.src = options.host + '/embed/' + options.videoId + '?enablejsapi=1&origin=' + encodeURIComponent(location.origin);
    iframe.setAttribute('width', String(options.width));
    iframe.setAttribute('height', String(options.height));
    iframe.setAttribute('title', 'YouTube video player');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allow', 'autoplay; encrypted-media');
    this.iframe = iframe;
    target.replaceWith(iframe);
    registry.players.push(this);
    setTimeout(function () {
      if (self.destroyed) return;
      self.fire('onReady', {});
      if (registry.config.blockedIds.indexOf(self.videoId) < 0) {
        self.setState(STATE.CUED);
        return;
      }
      // Like the real one: no cue, and the error a moment after ready.
      setTimeout(function () { self.fire('onError', { data: 150 }); }, 150);
    }, registry.config.readyDelayMs);
  }
  FakePlayer.prototype = {
    fire: function (name, extra) {
      var callback = this.events[name];
      if (callback && !this.destroyed) callback(Object.assign({ target: this }, extra));
    },
    setState: function (next) {
      if (this.state === STATE.PLAYING && next !== STATE.PLAYING) this.baseS = this.getCurrentTime();
      if (next === STATE.PLAYING && this.state !== STATE.PLAYING) this.startedAtMs = performance.now();
      this.state = next;
      this.fire('onStateChange', { data: next });
    },
    getCurrentTime: function () {
      if (this.ad) return (performance.now() - this.ad.startedAtMs) / 1000;
      if (this.state !== STATE.PLAYING) return this.baseS;
      return this.baseS + ((performance.now() - this.startedAtMs) / 1000) * this.rate;
    },
    getDuration: function () { return this.ad ? this.ad.durationS : registry.config.durationS; },
    getPlayerState: function () { return this.state; },
    getPlaybackRate: function () { return this.rate; },
    getVideoData: function () {
      return this.ad
        ? { video_id: this.ad.id, title: 'An advertisement' }
        : { video_id: this.videoId, title: registry.config.title };
    },
    playVideo: function () {
      var self = this;
      this.calls.push('playVideo');
      if (this.state === STATE.PLAYING || this.state === STATE.BUFFERING) return;
      this.setState(STATE.BUFFERING);
      setTimeout(function () {
        if (!self.destroyed && self.state === STATE.BUFFERING) self.setState(STATE.PLAYING);
      }, 60);
    },
    mute: function () {
      this.calls.push('mute');
      this.muted = true;
    },
    unMute: function () {
      this.calls.push('unMute');
      this.muted = false;
    },
    isMuted: function () { return this.muted; },
    pauseVideo: function () {
      this.calls.push('pauseVideo');
      if (this.state === STATE.PLAYING || this.state === STATE.BUFFERING) this.setState(STATE.PAUSED);
    },
    seekTo: function (seconds) {
      // As documented, seeking a cued, unstarted or ended video plays it.
      var cold = this.state === STATE.CUED || this.state === STATE.UNSTARTED || this.state === STATE.ENDED;
      this.calls.push('seekTo:' + seconds);
      this.baseS = seconds;
      this.startedAtMs = performance.now();
      if (cold) this.playVideo();
    },
    cueVideoById: function (options) {
      this.calls.push('cue:' + (options.startSeconds || 0));
      this.baseS = options.startSeconds || 0;
      this.setState(STATE.CUED);
    },
    destroy: function () {
      this.calls.push('destroy');
      this.destroyed = true;
      if (this.iframe.parentNode) this.iframe.remove();
    },
    scrubTo: function (seconds) {
      // Like a click on the real timeline: it buffers, then plays from there.
      var self = this;
      this.setState(STATE.BUFFERING);
      this.baseS = seconds;
      setTimeout(function () { if (!self.destroyed) self.setState(STATE.PLAYING); }, 60);
    },
    stall: function (ms) {
      // The network gives out: the clock stands still, then goes on from where
      // it stopped.
      var self = this;
      this.setState(STATE.BUFFERING);
      setTimeout(function () { if (!self.destroyed) self.setState(STATE.PLAYING); }, ms);
    },
    fireError: function (code) { this.fire('onError', { data: code }); },
    blockAutoplay: function () { this.fire('onAutoplayBlocked', {}); },
    startAd: function (id, durationS) {
      var self = this;
      // The video stops (its time is kept), then the ad buffers and plays.
      this.setState(STATE.BUFFERING);
      this.ad = { id: id, durationS: durationS, startedAtMs: performance.now() };
      setTimeout(function () { if (!self.destroyed) self.setState(STATE.PLAYING); }, 50);
    },
    endAd: function () {
      var self = this;
      // The video comes back where it stopped, through buffering.
      this.ad = null;
      this.state = STATE.PAUSED;
      this.setState(STATE.BUFFERING);
      setTimeout(function () { if (!self.destroyed) self.setState(STATE.PLAYING); }, 50);
    },
  };
  window.YT = { Player: FakePlayer, PlayerState: STATE };
  setTimeout(function () {
    if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
  }, 0);
})();`;

/** A copy of the app state as the page holds it right now. */
export async function readAppState(page: Page): Promise<AppState> {
  return page.evaluate(() => JSON.parse(JSON.stringify(window.encore!.store.state)) as AppState);
}

/** What the n-th fake player has recorded about itself. */
export async function readFakeHandle(page: Page, index: number): Promise<FakeHandle> {
  return page.evaluate((i) => {
    const p = (window as unknown as { __yt: { players: FakeHandle[] } }).__yt.players[i];
    return JSON.parse(
      JSON.stringify({
        videoId: p.videoId,
        destroyed: p.destroyed,
        muted: p.muted,
        calls: p.calls,
        options: p.options,
      }),
    ) as FakeHandle;
  }, index);
}

/** Calls a control method on the n-th fake player. */
export async function callFake(
  page: Page,
  index: number,
  method: string,
  ...args: Array<string | number>
): Promise<void> {
  await page.evaluate(
    ({ i, name, params }) => {
      const player = (window as unknown as { __yt: { players: Array<Record<string, (...a: unknown[]) => void>> } })
        .__yt.players[i];
      player[name](...params);
    },
    { i: index, name: method, params: args },
  );
}

/** Pastes `text` as if from the clipboard, onto the page or onto a field. */
export async function pasteInto(page: Page, text: string, selector?: string): Promise<void> {
  await page.evaluate(
    ({ value, target }) => {
      const element = target ? (document.querySelector(target) as HTMLElement) : document.body;
      const data = new DataTransfer();
      data.setData('text', value);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { value: text, target: selector ?? null },
  );
}

/** How many fake players have been built so far. */
export async function countFakePlayers(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __yt: { players: unknown[] } }).__yt.players.length);
}

/** Sets how long the next fake players take to report ready. */
export async function setReadyDelay(page: Page, ms: number): Promise<void> {
  await page.evaluate((delay) => {
    (window as unknown as { __yt: { config: { readyDelayMs: number } } }).__yt.config.readyDelayMs = delay;
  }, ms);
}

/** A take as it sits in IndexedDB, without its audio. */
export interface StoredTake {
  songHash: string;
  clock?: string;
  latencyS: number;
  durationS: number;
  startedAtSongS: number;
  frames: Array<{ t: number; f0: number }>;
}

/** The takes in IndexedDB, without their audio. */
export async function readStoredTakes(page: Page): Promise<StoredTake[]> {
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
    return records.map((r) => ({
      songHash: r.songHash as string,
      clock: r.clock as string | undefined,
      latencyS: r.latencyS as number,
      durationS: r.durationS as number,
      startedAtSongS: r.startedAtSongS as number,
      frames: r.frames as Array<{ t: number; f0: number }>,
    }));
  });
}
