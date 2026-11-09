/**
 * The left (song) panel's chrome: the (i) buttons beside section titles and
 * the panel's size. Two jobs, both wired to markup that index.html and the
 * other panels already own.
 *
 * Info notes. A title that carries `data-info` and `data-help` explains its
 * section in that help text. Hovering the title shows it as hover help (when
 * that is on); this module also adds a small (i) button after the title text,
 * and pressing it opens the same words as a note under the title, whether or
 * not hover help is on. One note is open at a time; a second press or Escape
 * closes it. A title with empty help (such as the Song reference title in
 * karaoke mode) has no button, so nothing from learning mode shows there. A
 * panel changes the words by changing `data-help`; the buttons follow.
 *
 * Size. The handle on the panel's right edge (a keyboard-reachable separator)
 * drags the panel's width within the limits in ../panel-layout, folds it into
 * a slim rail of section icons when pulled narrower than the threshold, and
 * moves with the arrow keys, Home, End and Enter. The collapse button in the
 * panel's header and the expand button in the rail do the same by click. The
 * width and the fold are remembered in this browser (not in the settings
 * file, since a width suits one screen); `reset` puts them back, which Reset
 * all in Settings calls. The grid column reads `--panel-w` set on #app, so
 * the stage fills the rest and the lane's own observer re-measures its canvas.
 * In a phone-width window the panel stacks above the stage and the handle is
 * hidden by CSS; only the collapse button remains.
 */
import {
  DEFAULT_LAYOUT,
  PHONE_MAX_WIDTH,
  RAIL_SECTIONS,
  RAIL_WIDTH,
  effectiveWidth,
  keyResult,
  maxWidth,
  nextInfoOpen,
  parseLayout,
  resolveDrag,
  serializeLayout,
} from '../panel-layout';
import type { PanelLayout } from '../panel-layout';
import { localStorageStore } from '../storage';
import type { KeyValueStore } from '../storage';

/** Storage key of the remembered layout (the store adds its own prefix). */
export const LAYOUT_STORAGE_KEY = 'panel';

/** What the panel chrome needs besides the page: where to remember the layout. */
export interface LeftPanelDeps {
  storage?: KeyValueStore;
}

/** The mounted chrome: put the layout back to its default, or take it all down. */
export interface LeftPanel {
  reset(): void;
  dispose(): void;
}

function must<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`index.html is missing #${id}`);
  return el as T;
}

/** One title's (i) button and note. */
interface InfoEntry {
  id: string;
  label: string;
  button: HTMLButtonElement;
  note: HTMLElement;
}

/** Adds an (i) button and note to every `[data-info]` title in `panel`; returns the take-down. */
function mountInfoNotes(panel: HTMLElement): () => void {
  const doc = panel.ownerDocument;
  const entries = new Map<HTMLElement, InfoEntry>();
  let open: string | null = null;
  let counter = 0;

  const textOf = (heading: HTMLElement): string => (heading.dataset.help ?? '').trim();

  const draw = (): void => {
    for (const [heading, entry] of entries) {
      const text = textOf(heading);
      // Help that goes away takes its open state with it, so the note does not
      // pop open unasked when the words come back (learning mode, a second singer).
      if (text === '' && open === entry.id) open = null;
      // A focused button about to be hidden hands its focus to the title.
      if (text === '' && entry.button === doc.activeElement) {
        heading.tabIndex = -1;
        heading.focus();
      }
      const shown = open === entry.id;
      entry.button.hidden = text === '';
      entry.button.setAttribute('aria-expanded', String(shown));
      if (entry.note.textContent !== text) entry.note.textContent = text;
      entry.note.hidden = !shown;
    }
  };

  const toggle = (id: string): void => {
    open = nextInfoOpen(open, id);
    draw();
  };

  const make = (heading: HTMLElement): InfoEntry => {
    counter += 1;
    const id = `info-note-${counter}`;
    const label = (heading.textContent ?? '').trim();
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'info-button';
    button.dataset.testid = 'info-button';
    button.textContent = 'i';
    button.setAttribute('aria-label', `About ${label}`);
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', id);
    button.addEventListener('click', () => toggle(id));
    // The page-wide Space shortcut plays and pauses; here Space presses the
    // button, as it does on any button, on the key going down (the click the
    // browser would add on release is swallowed).
    button.addEventListener('keydown', (ev) => {
      if (ev.key !== ' ') return;
      ev.preventDefault();
      ev.stopPropagation();
      if (!ev.repeat) toggle(id);
    });
    button.addEventListener('keyup', (ev) => {
      if (ev.key === ' ') ev.preventDefault();
    });
    const note = doc.createElement('div');
    note.id = id;
    note.className = 'info-note';
    note.dataset.testid = 'info-note';
    note.setAttribute('role', 'note');
    note.hidden = true;
    return { id, label, button, note };
  };

  const sync = (): void => {
    for (const [heading, entry] of entries) {
      if (heading.isConnected) continue;
      entry.button.remove();
      entry.note.remove();
      if (open === entry.id) open = null;
      entries.delete(heading);
    }
    for (const heading of panel.querySelectorAll<HTMLElement>('[data-info]')) {
      let entry = entries.get(heading);
      if (!entry) {
        entry = make(heading);
        entries.set(heading, entry);
      }
      // A panel that rewrites its title's text drops the button; put it back.
      if (entry.button.parentElement !== heading) heading.append(entry.button);
      if (entry.note.previousElementSibling !== heading) heading.after(entry.note);
    }
    draw();
  };

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || open === null) return;
    const entry = [...entries.values()].find((e) => e.id === open);
    const hadFocus = entry !== undefined && (entry.button === doc.activeElement || entry.note.contains(doc.activeElement));
    open = null;
    draw();
    if (hadFocus) entry.button.focus();
  };

  const observer = new MutationObserver(sync);
  observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-help', 'data-info'] });
  doc.addEventListener('keydown', onKey);
  sync();

  return () => {
    observer.disconnect();
    doc.removeEventListener('keydown', onKey);
    for (const entry of entries.values()) {
      entry.button.remove();
      entry.note.remove();
    }
    entries.clear();
  };
}

/** Mounts the panel chrome onto the page; see the file header. */
export function mountLeftPanel(doc: Document, deps: LeftPanelDeps = {}): LeftPanel {
  const win = doc.defaultView;
  const app = must(doc, 'app');
  const panel = must(doc, 'song-panel');
  const resizer = must(doc, 'panel-resizer');
  const collapseButton = must<HTMLButtonElement>(doc, 'panel-collapse');
  const expandButton = must<HTMLButtonElement>(doc, 'panel-expand');
  const rail = must(doc, 'panel-rail');
  const storage = deps.storage ?? localStorageStore();
  const cleanups: Array<() => void> = [];
  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ): void => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  cleanups.push(mountInfoNotes(panel));

  let layout: PanelLayout = parseLayout(storage.get(LAYOUT_STORAGE_KEY));
  const windowWidth = (): number => doc.documentElement.clientWidth || win?.innerWidth || 1280;
  const isPhone = (): boolean => (win?.matchMedia?.(`(max-width: ${PHONE_MAX_WIDTH}px)`).matches ?? false);

  // ---- The rail's icons ---------------------------------------------------

  const railItems = RAIL_SECTIONS.map((section) => {
    const item = doc.createElement('button');
    item.type = 'button';
    item.className = 'rail-item';
    item.dataset.testid = `rail-${section.target}`;
    item.dataset.target = section.target;
    item.dataset.help = section.label;
    item.textContent = section.glyph;
    item.setAttribute('aria-label', section.label);
    listen(item, 'click', () => {
      setLayout({ ...layout, collapsed: false }, true);
      collapseButton.focus();
      // After the panel has its sections back, so there is somewhere to scroll.
      requestAnimationFrame(() => doc.getElementById(section.target)?.scrollIntoView({ block: 'start' }));
    });
    rail.append(item);
    return item;
  });

  /** Shows an icon only for a section that is on the page right now. */
  const refreshRail = (): void => {
    for (const item of railItems) {
      const target = doc.getElementById(item.dataset.target ?? '');
      const hidden = !target || target.hidden;
      if (item.hidden !== hidden) item.hidden = hidden;
    }
  };
  let railFrame = 0;
  const railObserver = new MutationObserver((records) => {
    if (records.every((r) => rail.contains(r.target))) return;
    if (railFrame !== 0) return;
    railFrame = requestAnimationFrame(() => {
      railFrame = 0;
      refreshRail();
    });
  });
  const watchRail = (on: boolean): void => {
    railObserver.disconnect();
    if (on) railObserver.observe(panel, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  };
  cleanups.push(() => {
    railObserver.disconnect();
    if (railFrame !== 0) cancelAnimationFrame(railFrame);
  });

  // ---- Applying the layout ------------------------------------------------

  function apply(): void {
    const w = windowWidth();
    const width = effectiveWidth(layout, w);
    app.style.setProperty('--panel-w', `${width}px`);
    app.dataset.panel = layout.collapsed ? 'rail' : 'open';
    collapseButton.setAttribute('aria-expanded', String(!layout.collapsed));
    expandButton.setAttribute('aria-expanded', String(layout.collapsed));
    resizer.setAttribute('aria-valuemin', String(RAIL_WIDTH));
    resizer.setAttribute('aria-valuemax', String(maxWidth(w)));
    resizer.setAttribute('aria-valuenow', String(width));
    resizer.setAttribute('aria-valuetext', layout.collapsed ? 'Folded into the rail' : `${width} pixels wide`);
    if (layout.collapsed) refreshRail();
    watchRail(layout.collapsed);
  }

  function persist(): void {
    if (layout.width === null && !layout.collapsed) storage.remove(LAYOUT_STORAGE_KEY);
    else storage.set(LAYOUT_STORAGE_KEY, serializeLayout(layout));
  }

  function setLayout(next: PanelLayout, save: boolean): void {
    layout = next;
    apply();
    if (save) persist();
  }

  const toggleCollapsed = (): void => {
    const folding = !layout.collapsed;
    setLayout({ ...layout, collapsed: folding }, true);
    // The button that held focus is hidden now; its counterpart takes over.
    (folding ? expandButton : collapseButton).focus();
  };
  listen(collapseButton, 'click', toggleCollapsed);
  listen(expandButton, 'click', toggleCollapsed);

  // ---- Dragging the edge --------------------------------------------------

  let drag: { id: number; startX: number; startWidth: number; x: number } | null = null;
  let dragFrame = 0;

  const flushDrag = (): void => {
    dragFrame = 0;
    if (!drag) return;
    const result = resolveDrag(drag.startWidth + drag.x - drag.startX, windowWidth());
    if (result.kind === 'collapse') setLayout({ ...layout, collapsed: true }, false);
    else setLayout({ width: result.width, collapsed: false }, false);
  };
  const endDrag = (ev: PointerEvent): void => {
    if (!drag || drag.id !== ev.pointerId) return;
    if (dragFrame !== 0) {
      cancelAnimationFrame(dragFrame);
      flushDrag();
    }
    drag = null;
    app.classList.remove('is-resizing');
    if (resizer.hasPointerCapture?.(ev.pointerId)) resizer.releasePointerCapture(ev.pointerId);
    persist();
  };
  listen(resizer, 'pointerdown', (ev) => {
    if (ev.button !== 0 || isPhone()) return;
    ev.preventDefault();
    resizer.focus();
    resizer.setPointerCapture?.(ev.pointerId);
    drag = { id: ev.pointerId, startX: ev.clientX, startWidth: panel.getBoundingClientRect().width, x: ev.clientX };
    app.classList.add('is-resizing');
  });
  listen(resizer, 'pointermove', (ev) => {
    if (!drag || drag.id !== ev.pointerId) return;
    drag.x = ev.clientX;
    // One layout change per frame, however fast the pointer reports.
    if (dragFrame === 0) dragFrame = requestAnimationFrame(flushDrag);
  });
  listen(resizer, 'pointerup', endDrag);
  listen(resizer, 'pointercancel', endDrag);
  cleanups.push(() => {
    if (dragFrame !== 0) cancelAnimationFrame(dragFrame);
    app.classList.remove('is-resizing');
  });

  listen(resizer, 'keydown', (ev) => {
    if (isPhone()) return;
    // A folded panel is already as narrow as it goes; only widening or Enter act.
    if (layout.collapsed && ev.key === 'ArrowLeft') {
      ev.preventDefault();
      return;
    }
    const w = windowWidth();
    const result = keyResult(ev.key, ev.shiftKey, effectiveWidth(layout, w), w);
    if (!result) return;
    ev.preventDefault();
    if (result.kind === 'toggle') toggleCollapsedKeepingFocus();
    else setLayout({ width: result.width, collapsed: false }, true);
  });
  // Enter on the handle folds or unfolds; focus stays on the handle.
  function toggleCollapsedKeepingFocus(): void {
    setLayout({ ...layout, collapsed: !layout.collapsed }, true);
  }

  // ---- The window ---------------------------------------------------------

  let resizeFrame = 0;
  const onWindowResize = (): void => {
    if (resizeFrame !== 0) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      apply();
    });
  };
  win?.addEventListener('resize', onWindowResize);
  cleanups.push(() => {
    win?.removeEventListener('resize', onWindowResize);
    if (resizeFrame !== 0) cancelAnimationFrame(resizeFrame);
  });

  apply();

  return {
    reset(): void {
      layout = { ...DEFAULT_LAYOUT };
      apply();
      storage.remove(LAYOUT_STORAGE_KEY);
    },
    dispose(): void {
      for (const cleanup of cleanups.splice(0)) cleanup();
      app.style.removeProperty('--panel-w');
      delete app.dataset.panel;
      for (const item of railItems) item.remove();
    },
  };
}
