/**
 * The learning-mode panel in the song panel, in two parts that never show in
 * karaoke mode. Before the take: on a karaoke track (no original singer to
 * compare against) the notice that says so, with "Find the original". After
 * it: the take's report card, which says plainly how the singing went (the
 * words are src/app/report.ts), names the three worst phrases each with Jump
 * (seek the song there) and Replay (play the take from there), each with a
 * Mark free / Free toggle for the phrase, and offers a Tips button; tips come
 * only when asked, from src/coach/tips.ts. An Open take (or a Strict one with
 * free phrases) adds the freestyle block: the share on the melody, the share of
 * free notes in the song's key, and each note off key with a Jump. On a karaoke
 * track Strict says it cannot score and offers Switch to Open, which scores the
 * track on the song's key. Drawn from the state through `karaokeTrackNotice` and
 * `openReport` (src/app/learning.ts), which answer nothing in karaoke mode, so
 * this panel is then hidden.
 */
import { isMarked } from '../../analysis/free-phrases';
import type { Span } from '../../analysis/free-phrases';
import { tipsFor } from '../../coach/tips';
import type { Tip } from '../../coach/tips';
import { karaokeTrackNotice, openReport, openSwitchOffer, originalQueryFor } from '../learning';
import { describeReport, jumpTarget } from '../report';
import type { MomentView, ReportView } from '../report';
import type { Session } from '../session';
import type { AppState, StateStore } from '../state';
import type { MountPanel } from './panel';

/** The keys of the state the panel is drawn from. */
const WATCHED: ReadonlyArray<keyof AppState> = [
  'mode',
  'song',
  'pickedResult',
  'reference',
  'takes',
  'reportTakeId',
  'recording',
  'calibrating',
  'scoring',
  'key',
  'freePhrases',
];

/** Said when a take earns no tip. */
export const NO_TIPS = 'Nothing in this take stands out enough for a tip.';

/** What the panel needs: the state to draw, and the intents it calls. */
export interface ReportPanelDeps {
  store: StateStore;
  session: Pick<Session, 'seek' | 'playTake' | 'findOriginal' | 'showReport' | 'setScoring' | 'setPhraseFree'>;
}

/** Builds the panel into `host`; the returned function takes it down. */
export const mountReportPanel: MountPanel<ReportPanelDeps> = (host, { store, session }) => {
  const doc = host.ownerDocument;
  const cleanups: Array<() => void> = [];
  // The take whose tips were asked for; the tips go when another card opens.
  let tipsShownFor: string | null = null;

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    testid: string,
    className = '',
    text = '',
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.dataset.testid = testid;
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(text: string, testid: string, onClick: () => void, disabled = false): HTMLButtonElement {
    const b = el('button', testid, '', text);
    b.type = 'button';
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  /** A line about a moment in the song, with a Jump to it. */
  function moment(
    view: MomentView,
    testid: string,
    actions: Array<[string, string, () => void]>,
    disabled: boolean,
  ): HTMLLIElement {
    const item = doc.createElement('li');
    item.dataset.testid = testid;
    const text = doc.createElement('span');
    text.textContent = view.text;
    item.append(text);
    for (const [label, id, run] of actions) item.append(button(label, id, run, disabled));
    return item;
  }

  function list(items: HTMLElement[], testid: string): HTMLUListElement {
    const ul = el('ul', testid, 'report-list');
    ul.append(...items);
    return ul;
  }

  function tipItem(tip: Tip, busy: boolean): HTMLLIElement {
    const item = doc.createElement('li');
    item.dataset.testid = 'tip';
    item.dataset.tip = tip.id;
    item.append(
      el('strong', 'tip-message', '', tip.message),
      el('span', 'tip-evidence', 'song-meta', tip.evidence),
      button('Jump', 'tip-jump', () => session.seek(jumpTarget(tip.jumpToS)), busy),
    );
    return item;
  }

  /** The Mark free / Free toggle for a phrase: pressed when it is marked free. */
  function freeToggle(takeId: string, span: Span, marked: boolean, busy: boolean, testid: string): HTMLButtonElement {
    const toggle = button(marked ? 'Free' : 'Mark free', testid, () => void session.setPhraseFree(takeId, span, !marked), busy);
    toggle.setAttribute('aria-pressed', String(marked));
    toggle.title = marked
      ? 'This phrase is free: ad-libs there are judged against the key. Press to score it against the melody again.'
      : 'Judge this phrase against the key instead of the melody, for ad-libs.';
    return toggle;
  }

  /** The freestyle block: the summary, why the key could not judge, and each off-key note. */
  function freestyleBlock(view: ReportView, busy: boolean): HTMLElement[] {
    const block = view.freestyle;
    if (block === null) return [];
    const parts: HTMLElement[] = [el('h4', 'report-freestyle-title', 'report-sub', 'Freestyle')];
    parts.push(el('p', 'report-freestyle', 'report-line', block.summary));
    if (block.keyNote) parts.push(el('p', 'report-key-note', 'song-meta', block.keyNote));
    if (block.offNotes.length > 0) {
      parts.push(
        list(
          block.offNotes.map((n) =>
            moment(n, 'report-offkey-note', [['Jump', 'note-jump', () => session.seek(jumpTarget(n.atS))]], busy),
          ),
          'report-offkey-notes',
        ),
      );
      if (block.moreOff > 0) parts.push(el('p', 'report-more-offkey', 'song-meta', `and ${block.moreOff} more`));
    }
    return parts;
  }

  function card(state: AppState, open: NonNullable<ReturnType<typeof openReport>>): HTMLElement {
    const { take, report } = open;
    const busy = state.recording || state.calibrating;
    const view = describeReport(report);
    const root = el('div', 'report-card', 'report-card');
    root.dataset.takeId = take.id;
    root.dataset.style = view.style;

    const head = el('div', 'report-head', 'report-head');
    head.append(
      el('h3', 'report-title', 'group-title', 'Take report'),
      button('Close', 'report-close', () => session.showReport(null)),
    );
    root.append(head, el('p', 'report-headline', 'report-headline', view.headline));
    if (view.melodyShare) root.append(el('p', 'report-melody-share', 'report-line', view.melodyShare));
    if (view.coverage) root.append(el('p', 'report-coverage', 'song-meta', view.coverage));
    if (view.frames) root.append(el('p', 'report-frames', 'song-meta', view.frames));

    if (view.offNotes.length > 0) {
      root.append(el('h4', 'report-off-title', 'report-sub', 'Off notes'));
      root.append(
        list(
          view.offNotes.map((n) =>
            moment(n, 'report-note', [['Jump', 'note-jump', () => session.seek(jumpTarget(n.atS))]], busy),
          ),
          'report-notes',
        ),
      );
      if (view.moreOff > 0) root.append(el('p', 'report-more', 'song-meta', `and ${view.moreOff} more`));
    }
    if (view.hasMelody) {
      root.append(el('p', 'report-timing', 'report-line', view.timing));

      root.append(el('h4', 'report-phrases-title', 'report-sub', 'Worst phrases'));
      if (view.phrases.length > 0) {
        root.append(
          list(
            view.phrases.map((p, i) => {
              const row = moment(
                p,
                'report-phrase',
                [
                  ['Jump', 'phrase-jump', () => session.seek(jumpTarget(p.atS))],
                  ['Replay', 'phrase-replay', () => void session.playTake(take.id, p.atS)],
                ],
                busy,
              );
              const span = view.phraseSpans[i];
              row.append(freeToggle(take.id, span, isMarked(state.freePhrases, span), busy, 'phrase-free'));
              return row;
            }),
            'report-phrases',
          ),
        );
      } else {
        root.append(el('p', 'report-no-phrases', 'song-meta', view.noPhrases));
      }
      root.append(el('p', 'report-range', 'song-meta', view.range));
    }

    root.append(...freestyleBlock(view, busy));
    if (view.freePhrases.length > 0) {
      root.append(el('h4', 'report-free-title', 'report-sub', 'Free phrases'));
      root.append(
        list(
          view.freePhrases.map((p) => {
            const row = moment(p, 'report-free-phrase', [['Jump', 'free-jump', () => session.seek(jumpTarget(p.atS))]], busy);
            row.dataset.free = 'true';
            row.append(freeToggle(take.id, p.span, isMarked(state.freePhrases, p.span), busy, 'free-phrase-toggle'));
            return row;
          }),
          'report-free-phrases',
        ),
      );
    }

    const asked = tipsShownFor === take.id;
    root.append(
      button('Tips', 'report-tips', () => {
        tipsShownFor = take.id;
        render(store.state);
      }, asked),
    );
    if (asked) {
      const tips = tipsFor(report);
      root.append(
        tips.length > 0
          ? list(
              tips.map((t) => tipItem(t, busy)),
              'tips',
            )
          : el('p', 'tips-none', 'song-meta', NO_TIPS),
      );
    }
    return root;
  }

  function notice(text: string, state: AppState): HTMLElement {
    const box = el('div', 'learning-notice', 'learning-notice');
    box.setAttribute('role', 'status');
    box.append(el('p', 'learning-notice-text', '', text));
    const offer = openSwitchOffer(state);
    if (offer !== null) box.append(el('p', 'learning-notice-offer', '', offer));
    const actions = el('div', 'learning-actions', 'learning-actions');
    actions.append(button('Find the original', 'find-original', () => session.findOriginal(originalQueryFor(state))));
    if (offer !== null) actions.append(button('Switch to Open', 'switch-to-open', () => session.setScoring('open')));
    box.append(actions);
    return box;
  }

  function render(state: AppState): void {
    const text = karaokeTrackNotice(state);
    const open = openReport(state);
    host.hidden = text === null && open === null;
    if (open === null) tipsShownFor = null;
    const parts: HTMLElement[] = [];
    if (text !== null) parts.push(notice(text, state));
    if (open !== null) parts.push(card(state, open));
    host.replaceChildren(...parts);
  }

  cleanups.push(
    store.subscribe((state, changed) => {
      if (WATCHED.some((key) => changed.has(key))) render(state);
    }),
  );
  render(store.state);

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    host.replaceChildren();
  };
};
