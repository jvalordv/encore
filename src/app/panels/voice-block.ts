/**
 * The "Your voice" block of the report card: the take's own measurements
 * (src/app/voice-report.ts) as lines, then the notes furthest from their tone,
 * each with its measurements and a tip, then Jump (seek the song there) and
 * Replay (play the take from there).
 * Built apart from the card so the card's file stays small; it has no state
 * and is never built in karaoke mode (the card is not).
 */
import { jumpTarget } from '../report';
import type { MomentView } from '../report';
import type { VoiceView } from '../voice-report';

/** What the block calls on: the two moves a worst note offers. */
export interface VoiceBlockActions {
  seek(s: number): void;
  replay(atS: number): void;
}

/**
 * The text of a replay item: the summary line, then the muted detail line of
 * numbers (evidence, always shown) and, only when the singer has asked for
 * tips on this card, the tip (learning mode's replay items).
 */
export function momentTexts(doc: Document, view: MomentView, showTip = false): HTMLElement[] {
  const summary = doc.createElement('span');
  summary.textContent = view.text;
  const out: HTMLElement[] = [summary];
  const extra: Array<[string | undefined, string, string]> = [
    [view.detail, 'report-moment-detail', 'song-meta report-moment-detail'],
    [showTip ? view.tip : undefined, 'report-moment-tip', 'song-meta report-moment-tip'],
  ];
  for (const [text, testid, className] of extra) {
    if (!text) continue;
    const line = doc.createElement('span');
    line.dataset.testid = testid;
    line.className = className;
    line.textContent = text;
    out.push(line);
  }
  return out;
}

/** The block's elements; empty when the take has no voice section. */
export function voiceBlock(
  doc: Document,
  view: VoiceView | null,
  actions: VoiceBlockActions,
  busy: boolean,
  showTips = false,
): HTMLElement[] {
  if (view === null) return [];
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, testid: string, className: string, text: string) => {
    const node = doc.createElement(tag);
    node.dataset.testid = testid;
    node.className = className;
    node.textContent = text;
    return node;
  };
  const parts: HTMLElement[] = [make('h4', 'report-voice-title', 'report-sub', 'Your voice')];
  const lines: Array<[string, string, string]> = [
    ['report-voice-basis', 'song-meta', view.basis],
    ['report-voice-intonation', 'report-line', view.intonation],
    ['report-voice-stability', 'report-line', view.stability],
    ['report-voice-scoop', 'report-line', view.scoop],
    ['report-voice-drift', 'report-line', view.drift],
    ['report-voice-vibrato', 'report-line', view.vibrato],
    ['report-voice-range', 'song-meta', view.range],
    ['report-voice-phrases', 'report-line', view.phrases],
  ];
  for (const [testid, className, text] of lines) if (text) parts.push(make('p', testid, className, text));
  if (view.worstNotes.length > 0) {
    const ul = make('ul', 'report-voice-notes', 'report-list', '');
    for (const note of view.worstNotes) {
      const item = doc.createElement('li');
      item.dataset.testid = 'report-voice-note';
      item.append(...momentTexts(doc, note, showTips));
      const buttons: Array<[string, string, () => void]> = [
        ['Jump', 'voice-note-jump', () => actions.seek(jumpTarget(note.atS))],
        ['Replay', 'voice-note-replay', () => actions.replay(note.atS)],
      ];
      for (const [label, testid, run] of buttons) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.dataset.testid = testid;
        b.textContent = label;
        b.disabled = busy;
        b.addEventListener('click', run);
        item.append(b);
      }
      ul.append(item);
    }
    parts.push(ul);
    if (view.moreOff > 0) parts.push(make('p', 'report-voice-more', 'song-meta', `and ${view.moreOff} more`));
  }
  return parts;
}
