/**
 * The "Your voice" block of the report card: the take's own measurements
 * (src/app/voice-report.ts) as lines, then the notes furthest from their tone,
 * each with Jump (seek the song there) and Replay (play the take from there).
 * Built apart from the card so the card's file stays small; it has no state
 * and is never built in karaoke mode (the card is not).
 */
import { jumpTarget } from '../report';
import type { VoiceView } from '../voice-report';

/** What the block calls on: the two moves a worst note offers. */
export interface VoiceBlockActions {
  seek(s: number): void;
  replay(atS: number): void;
}

/** The block's elements; empty when the take has no voice section. */
export function voiceBlock(
  doc: Document,
  view: VoiceView | null,
  actions: VoiceBlockActions,
  busy: boolean,
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
      const text = doc.createElement('span');
      text.textContent = note.text;
      item.append(text);
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
