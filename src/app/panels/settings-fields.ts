/**
 * Form-control builders for the Settings panel (panels/settings.ts). Each
 * builder makes one labelled control, wires its change event to a write
 * function and registers a read function that the panel calls on every
 * redraw, so a control always shows what the stores hold, whichever control
 * (this one or an inline one) changed it. Nothing here knows a setting by
 * name; the panel supplies the reads and writes. Only the DOM calls the fake
 * document in test/fake-dom.ts supports are used.
 */
import type { AppState } from '../state';

/** A value and the words shown for it. */
export type Choice = readonly [value: string, label: string];

/** The builders, sharing one document and one list of redraws and cleanups. */
export interface Kit {
  /** Makes an element with a test id, optional class and text. */
  el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    testid: string,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K];
  /** A titled group appended to `parent`; returns its body. */
  section(parent: HTMLElement, title: string, testid: string): HTMLElement;
  button(parent: HTMLElement, text: string, testid: string, onClick: () => void): HTMLButtonElement;
  check(
    parent: HTMLElement,
    text: string,
    testid: string,
    read: (s: AppState) => boolean,
    write: (on: boolean) => void,
  ): HTMLInputElement;
  range(
    parent: HTMLElement,
    text: string,
    testid: string,
    bounds: readonly [min: number, max: number, step: number],
    read: (s: AppState) => number,
    write: (value: number) => void,
  ): HTMLInputElement;
  text(
    parent: HTMLElement,
    text: string,
    testid: string,
    type: 'text' | 'number' | 'password' | 'color',
    read: (s: AppState) => string,
    write: (value: string) => void,
  ): HTMLInputElement;
  select(
    parent: HTMLElement,
    text: string,
    testid: string,
    choices: (s: AppState) => readonly Choice[],
    read: (s: AppState) => string,
    write: (value: string) => void,
  ): HTMLSelectElement;
  segmented(
    parent: HTMLElement,
    text: string,
    testid: string,
    choices: readonly Choice[],
    read: (s: AppState) => string,
    write: (value: string) => void,
  ): HTMLElement;
  /** A line of plain text redrawn from the state. */
  line(parent: HTMLElement, testid: string, read: (s: AppState) => string): HTMLElement;
  /** Redraws every registered control from `state`. */
  render(state: AppState): void;
  /** Removes every listener the builders added. */
  dispose(): void;
}

/** Builds a Kit over `doc`. */
export function makeKit(doc: Document): Kit {
  const syncs: Array<(s: AppState) => void> = [];
  const cleanups: Array<() => void> = [];

  const el: Kit['el'] = (tag, testid, className = '', text = '') => {
    const node = doc.createElement(tag);
    node.dataset.testid = testid;
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const on = (target: HTMLElement, type: 'click' | 'change' | 'input', fn: () => void): void => {
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };
  const labelled = (parent: HTMLElement, text: string, control: HTMLElement, className: string): void => {
    const label = doc.createElement('label');
    label.className = className;
    label.append(doc.createTextNode(text), control);
    parent.append(label);
  };

  return {
    el,
    section(parent, title, testid) {
      const group = el('div', testid, 'panel-group settings-section');
      const heading = doc.createElement('h3');
      heading.className = 'group-title';
      heading.textContent = title;
      group.append(heading);
      parent.append(group);
      return group;
    },
    button(parent, text, testid, onClick) {
      const b = el('button', testid, 'compact', text);
      b.type = 'button';
      on(b, 'click', onClick);
      parent.append(b);
      return b;
    },
    check(parent, text, testid, read, write) {
      const box = el('input', testid);
      box.type = 'checkbox';
      on(box, 'change', () => write(box.checked));
      const label = doc.createElement('label');
      label.className = 'check';
      label.append(box, doc.createTextNode(` ${text}`));
      parent.append(label);
      syncs.push((s) => {
        box.checked = read(s);
      });
      return box;
    },
    range(parent, text, testid, [min, max, step], read, write) {
      const input = el('input', testid);
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      on(input, 'input', () => write(Number(input.value)));
      labelled(parent, text, input, 'field');
      syncs.push((s) => {
        if (doc.activeElement !== input) input.value = String(read(s));
      });
      return input;
    },
    text(parent, text, testid, type, read, write) {
      const input = el('input', testid);
      input.type = type;
      if (type === 'text' || type === 'password') input.autocomplete = 'off';
      on(input, 'change', () => write(input.value));
      labelled(parent, text, input, 'field');
      syncs.push((s) => {
        if (doc.activeElement !== input) input.value = read(s);
      });
      return input;
    },
    select(parent, text, testid, choices, read, write) {
      const pick = el('select', testid);
      on(pick, 'change', () => write(pick.value));
      labelled(parent, text, pick, 'field');
      let shown = '';
      syncs.push((s) => {
        const list = choices(s);
        const signature = JSON.stringify(list);
        if (signature !== shown) {
          shown = signature;
          pick.replaceChildren();
          for (const [value, label] of list) {
            const o = doc.createElement('option');
            o.value = value;
            o.textContent = label;
            pick.append(o);
          }
        }
        const want = read(s);
        pick.value = list.some(([value]) => value === want) ? want : (list[0]?.[0] ?? '');
      });
      return pick;
    },
    segmented(parent, text, testid, choices, read, write) {
      const group = el('div', testid, 'segmented');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', text);
      const buttons = choices.map(([value, label]) => {
        const b = el('button', `${testid}-${value}`, '', label);
        b.type = 'button';
        on(b, 'click', () => write(value));
        group.append(b);
        return [value, b] as const;
      });
      const caption = el('span', `${testid}-label`, 'field', text);
      parent.append(caption, group);
      syncs.push((s) => {
        const now = read(s);
        for (const [value, b] of buttons) b.setAttribute('aria-pressed', String(value === now));
      });
      return group;
    },
    line(parent, testid, read) {
      const p = el('p', testid, 'song-meta');
      parent.append(p);
      syncs.push((s) => {
        p.textContent = read(s);
      });
      return p;
    },
    render(state) {
      for (const sync of syncs) sync(state);
    },
    dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
