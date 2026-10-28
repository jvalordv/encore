/**
 * The pitch lane's two timing helpers: the redraw loop that paints at most
 * once per animation frame and only after a change, and the watcher that
 * notices devicePixelRatio changing (zoom, a window moved between monitors).
 * Both take their browser dependencies as arguments so tests need no browser.
 */

/** Where animation frames come from; injectable so tests need no browser. */
export interface FrameClock {
  request(cb: () => void): number;
  cancel(id: number): void;
}

/** requestAnimationFrame when present, else a 60 Hz timer (never throws). */
function defaultClock(): FrameClock {
  if (typeof requestAnimationFrame === 'function') {
    return {
      request: (cb) => requestAnimationFrame(() => cb()),
      cancel: (id) => cancelAnimationFrame(id),
    };
  }
  return {
    request: (cb) => setTimeout(cb, 16) as unknown as number,
    cancel: (id) => clearTimeout(id),
  };
}

/**
 * Calls `draw` at most once per animation frame, and only after
 * `invalidate`. It schedules a frame on demand rather than ticking while
 * idle, so a paused song with nothing changing costs nothing.
 */
export class RedrawLoop {
  private clock: FrameClock | null = null;
  private pending: number | null = null;
  private dirty = false;
  private active = false;

  constructor(
    private readonly draw: () => void,
    private readonly clockFactory: () => FrameClock = defaultClock,
  ) {}

  /** True between `start` and `stop`. */
  get running(): boolean {
    return this.active;
  }

  /** Marks the picture stale; a frame is scheduled if the loop is running. */
  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  /** Starts honouring invalidations; draws at once if one is waiting. */
  start(): void {
    this.active = true;
    this.schedule();
  }

  /** Stops scheduling and cancels any frame already requested. */
  stop(): void {
    this.active = false;
    if (this.pending !== null && this.clock) this.clock.cancel(this.pending);
    this.pending = null;
  }

  /** Forgets a pending invalidation, for callers that just drew directly. */
  settle(): void {
    this.dirty = false;
  }

  private schedule(): void {
    if (!this.active || !this.dirty || this.pending !== null) return;
    this.clock ??= this.clockFactory();
    this.pending = this.clock.request(() => {
      this.pending = null;
      if (!this.active || !this.dirty) return;
      this.dirty = false;
      this.draw();
    });
  }
}

/** The slice of a MediaQueryList the pixel-ratio watcher needs. */
export interface PixelRatioQuery {
  addEventListener?(type: 'change', cb: () => void): void;
  removeEventListener?(type: 'change', cb: () => void): void;
}

/** The slice of `window` the pixel-ratio watcher needs. */
export interface PixelRatioHost {
  devicePixelRatio: number;
  matchMedia?: (query: string) => PixelRatioQuery;
}

/**
 * Calls `onChange` with the new ratio whenever devicePixelRatio changes
 * (browser zoom, a window dragged between monitors). There is no event for
 * the ratio itself, so it listens to a `(resolution: Xdppx)` query that
 * stops matching when the ratio moves, then re-arms on the new value.
 * Returns a function that stops watching; degrades to a no-op without
 * matchMedia.
 */
export function watchPixelRatio(
  onChange: (ratio: number) => void,
  host?: PixelRatioHost,
): () => void {
  const win = host ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win || typeof win.matchMedia !== 'function') return () => undefined;
  const matchMedia = win.matchMedia.bind(win);

  let disarm: () => void = () => undefined;
  let stopped = false;
  const arm = (): void => {
    const query = matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    if (typeof query.addEventListener !== 'function') return;
    const handler = (): void => {
      disarm();
      if (stopped) return;
      onChange(win.devicePixelRatio || 1);
      // The callback may have disposed the watcher; do not revive it.
      if (!stopped) arm();
    };
    query.addEventListener('change', handler);
    disarm = () => query.removeEventListener?.('change', handler);
  };
  arm();
  return () => {
    stopped = true;
    disarm();
  };
}
