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
 * track Strict has no melody to compare with and offers Switch to Open, which
 * scores the track on the song's key. The card also shows the song's stars,
 * a flourish with one line when the take beat the song's best (src/app/fun.ts),
 * and Save card (.png). Every card ends with "Your voice"
 * (voice-block.ts), which stands alone when there is no melody. Drawn from the state through `karaokeTrackNotice` and
 * `openReport` (src/app/learning.ts), which answer nothing in karaoke mode, so
 * this panel is then hidden.
 */
import { isMarked } from '../../analysis/free-phrases';
import type { Span } from '../../analysis/free-phrases';
import { personalBest, takeStars } from '../../analysis/stars';
import { isSharedPhrase } from '../../duet/split';
import { takesOfSinger } from '../../duet/take';
import type { SingerReport } from '../../duet/take';
import { tipsFor } from '../../coach/tips';
import type { Tip } from '../../coach/tips';
import { describeAlign } from '../align';
import { cardContentOf } from '../card-content';
import { CARD_FAILED, drawCard, renderCardPng } from '../card-image';
import { cardFileName, localDateString } from '../card-layout';
import { downloadBlob } from '../download';
import { activeSkin, personalBestText, starGlyphs, starsLineFor } from '../fun';
import { karaokeTrackNotice, openReports, openSwitchOffer, originalQueryFor } from '../learning';
import { describeReport, jumpTarget } from '../report';
import type { MomentView, ReportView } from '../report';
import type { Session } from '../session';
import type { AppState, StateStore } from '../state';
import type { TakeSummary } from '../takes';
import type { MountPanel } from './panel';
import { voiceBlock } from './voice-block';

/** The keys of the state the panel is drawn from. */
const WATCHED: ReadonlyArray<keyof AppState> = [
  'mode',
  'song',
  'pickedResult',
  'reference',
  'align',
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

  /**
   * One singer's card. A take with two singers has two, each with its own
   * title, stars, best and tips, and the stretches both sang marked shared.
   */
  function card(state: AppState, take: TakeSummary, who: SingerReport, multi: boolean): HTMLElement {
    const { report } = who;
    const key = `${take.id}:${who.singer}`;
    const busy = state.recording || state.calibrating;
    const view = describeReport(report);
    const root = el('div', 'report-card', 'report-card');
    root.dataset.takeId = take.id;
    root.dataset.singer = String(who.singer);
    root.dataset.style = view.style;

    const head = el('div', 'report-head', 'report-head');
    head.append(
      el('h3', 'report-title', 'group-title', multi ? `Take report: ${who.name}` : 'Take report'),
      button('Close', 'report-close', () => session.showReport(null)),
    );
    root.append(head, el('p', 'report-headline', 'report-headline', view.headline));
    const skin = activeSkin(doc);
    const stars = takeStars(report);
    const starLine = starsLineFor(report, skin);
    // Each singer's best is among their own takes, so the two never mix.
    const best =
      who.singer === 0
        ? personalBest(take, state.takes)
        : personalBest({ ...take, report }, takesOfSinger(state.takes, 1));
    const bestLine = best === null ? '' : personalBestText(best, skin);
    if (starLine) {
      const row = el('p', 'report-stars', 'report-stars', `${starGlyphs(stars)} ${starLine}`);
      row.dataset.stars = String(stars);
      root.append(row);
    }
    if (bestLine) root.append(el('p', 'report-pb', 'report-pb', bestLine));
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
              if (isSharedPhrase(who.shared, span[0], span[1])) {
                row.dataset.shared = 'true';
                row.append(el('span', 'phrase-shared', 'song-meta', 'shared'));
              }
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
    root.append(
      ...voiceBlock(
        doc,
        view.voice,
        { seek: (s) => session.seek(s), replay: (s) => void session.playTake(take.id, s) },
        busy,
      ),
    );
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

    const cardStatus = el('p', 'report-card-status', 'song-meta');
    cardStatus.setAttribute('role', 'status');
    root.append(
      button('Save card (.png)', 'report-save-card', () => {
        cardStatus.textContent = '';
        const content = cardContentOf({
          view,
          songName: multi ? `${take.songName} (${who.name})` : take.songName,
          createdAt: take.createdAt,
          stars: starLine,
          personalBest: bestLine,
          skin,
        });
        void drawCard(renderCardPng, doc, content).then((blob) => {
          if (blob === null) cardStatus.textContent = CARD_FAILED;
          else downloadBlob(doc, blob, cardFileName(multi ? `${take.songName} ${who.name}` : take.songName, localDateString(take.createdAt)));
        });
      }),
      cardStatus,
    );
    const asked = tipsShownFor === key;
    root.append(
      button('Tips', 'report-tips', () => {
        tipsShownFor = key;
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
    // Why matching the original did not work sits beside the way out of it.
    const { align } = state;
    if (align.phase === 'refused' || align.phase === 'failed') {
      box.append(el('p', 'align-status', '', describeAlign(align)));
    }
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
    const open = openReports(state);
    host.hidden = text === null && open === null;
    if (open === null) tipsShownFor = null;
    const parts: HTMLElement[] = [];
    if (text !== null) parts.push(notice(text, state));
    if (open !== null) {
      const multi = open.cards.length > 1;
      for (const who of open.cards) parts.push(card(state, open.take, who, multi));
    }
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
