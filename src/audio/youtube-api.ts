/**
 * The YouTube IFrame Player API, as much of it as the app uses: its types
 * (declared here so there is no dependency on third-party typings) and the
 * loader that fetches its script. The script is requested only when a link is
 * first used, never at start-up, so the app stays free of network calls until
 * the singer asks for YouTube. The documented way in is a script tag whose
 * code calls a global, `onYouTubeIframeAPIReady`, once `YT.Player` exists. One
 * shared promise serves every caller; a failure or a timeout clears it, so a
 * later attempt (after the connection is back) tries again. The page's globals
 * and script insertion are injected, which is what lets the loader be tested
 * without a browser or a network.
 */

/** Player states as the API numbers them (`YT.PlayerState`). */
export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

/** What `getVideoData()` returns, reduced to the fields we read. */
export interface YouTubeVideoData {
  video_id?: string;
  title?: string;
  author?: string;
}

/** The slice of a `YT.Player` instance the transport calls. */
export interface YouTubePlayer {
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getPlaybackRate(): number;
  getVideoData(): YouTubeVideoData;
  isMuted(): boolean;
  mute(): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  cueVideoById(options: { videoId: string; startSeconds?: number }): void;
  destroy(): void;
}

/** What the player passes to its event callbacks. */
export interface YouTubePlayerEvent {
  target: YouTubePlayer;
  /** The state number or error code, depending on the event. */
  data?: number;
}

/** The callbacks the transport registers. */
export interface YouTubePlayerEvents {
  onReady?: (event: YouTubePlayerEvent) => void;
  onStateChange?: (event: YouTubePlayerEvent) => void;
  onError?: (event: YouTubePlayerEvent) => void;
  onAutoplayBlocked?: (event: YouTubePlayerEvent) => void;
}

/** The constructor options the transport passes. */
export interface YouTubePlayerOptions {
  host?: string;
  videoId?: string;
  width?: number | string;
  height?: number | string;
  playerVars?: Record<string, string | number>;
  events?: YouTubePlayerEvents;
}

/** The `YT` global once the API script has run. */
export interface YouTubeApi {
  Player: new (target: HTMLElement | string, options: YouTubePlayerOptions) => YouTubePlayer;
}

/** Where the API script comes from (the documented address). */
export const IFRAME_API_URL = 'https://www.youtube.com/iframe_api';

/** How long the script gets to define `YT.Player` before we give up. */
export const API_TIMEOUT_MS = 10_000;

/** What the singer is told when YouTube cannot be reached. */
export const API_UNREACHABLE = 'Could not reach YouTube. Check the connection.';

/** The page globals the loader reads and writes. */
export interface ApiScope {
  YT?: Partial<YouTubeApi>;
  onYouTubeIframeAPIReady?: (() => void) | undefined;
}

/** Everything the loader needs from the page; the default is the real one. */
export interface ApiEnv {
  scope: ApiScope;
  /** Adds the script; onError fires if it fails. Returns the remover. */
  addScript(src: string, onError: () => void): () => void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real page. Only called when a link is actually used. */
function browserEnv(): ApiEnv {
  const scope = globalThis as unknown as ApiScope;
  return {
    scope,
    addScript(src, onError) {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.addEventListener('error', onError);
      document.head.append(script);
      return () => script.remove();
    },
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  };
}

/** True once the API's player class exists on the scope. */
function ready(scope: ApiScope): scope is ApiScope & { YT: YouTubeApi } {
  return typeof scope.YT?.Player === 'function';
}

/** One shared load per page (per scope object), so callers share it. */
const loads = new WeakMap<object, Promise<YouTubeApi>>();

/**
 * Loads the IFrame API on first use and resolves with the `YT` namespace.
 * Calls made while a load is in flight share it; after a failure the next call
 * starts a fresh attempt. Rejects with API_UNREACHABLE on a script error or a
 * timeout. If the API is already on the page the promise resolves at once and
 * no script is added.
 */
export function loadYouTubeApi(env?: ApiEnv): Promise<YouTubeApi> {
  const page = env ?? browserEnv();
  const { scope } = page;
  if (ready(scope)) return Promise.resolve(scope.YT);
  const inFlight = loads.get(scope);
  if (inFlight) return inFlight;

  const attempt = new Promise<YouTubeApi>((resolve, reject) => {
    // Another script may already want the callback; ours calls it afterwards.
    const previous = scope.onYouTubeIframeAPIReady;
    let removeScript: () => void = () => undefined;
    let timer: unknown;
    let settled = false;

    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      page.clearTimeout(timer);
      outcome();
    };
    const fail = (): void =>
      settle(() => {
        removeScript();
        scope.onYouTubeIframeAPIReady = previous;
        loads.delete(scope);
        reject(new Error(API_UNREACHABLE));
      });

    scope.onYouTubeIframeAPIReady = () => {
      try {
        previous?.();
      } finally {
        if (ready(scope)) settle(() => resolve(scope.YT));
        else fail();
      }
    };
    timer = page.setTimeout(fail, API_TIMEOUT_MS);
    removeScript = page.addScript(IFRAME_API_URL, fail);
    // A script that failed before addScript returned has nothing left to remove
    // through `fail`, which saw the placeholder remover.
    if (settled) removeScript();
  });
  loads.set(scope, attempt);
  return attempt;
}
