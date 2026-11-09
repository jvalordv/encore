/**
 * The bar under the drop zone: one line and one progress bar for every song
 * dropped together, then one line for each song that failed and each file that
 * was not audio. Everything drawn comes from `ingestView` (src/app/ingest.ts),
 * a function of `state.ingest`; the panel holds no logic and calls no intent.
 * The bar is a native progress element, so assistive technology reads it.
 */
import { ingestView } from '../ingest';
import type { AppState, StateStore } from '../state';
import type { MountPanel } from './panel';

/** What the panel needs: the state to draw. */
export interface IngestPanelDeps {
  store: StateStore;
}

/** Builds the bar into `host`; the returned function takes it down. */
export const mountIngestPanel: MountPanel<IngestPanelDeps> = (host, { store }) => {
  const doc = host.ownerDocument;
  const cleanups: Array<() => void> = [];

  const line = doc.createElement('p');
  line.className = 'ingest-line song-meta';
  line.dataset.testid = 'ingest-line';
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  const bar = doc.createElement('progress');
  bar.className = 'ingest-bar';
  bar.dataset.testid = 'ingest-bar';
  bar.max = 1;
  bar.setAttribute('aria-label', 'Analysing the dropped songs');
  const problems = doc.createElement('ul');
  problems.className = 'ingest-problems song-meta';
  problems.dataset.testid = 'ingest-problems';
  host.append(line, bar, problems);

  let shown = '';

  function render(state: AppState): void {
    const view = ingestView(state.ingest);
    host.hidden = !view.visible;
    host.dataset.busy = String(view.busy);
    if (line.textContent !== view.line) line.textContent = view.line;
    line.hidden = view.line === '';
    // The bar moves while songs are being analysed and goes when they are done.
    bar.hidden = !view.busy;
    bar.value = view.fraction;
    const lines = [...view.failures, ...view.skipped];
    const signature = lines.join('\n');
    if (signature !== shown) {
      shown = signature;
      problems.replaceChildren(
        ...lines.map((text) => {
          const item = doc.createElement('li');
          item.textContent = text;
          return item;
        }),
      );
    }
    problems.hidden = lines.length === 0;
  }

  cleanups.push(
    store.subscribe((state, changed) => {
      if (changed.has('ingest')) render(state);
    }),
  );
  render(store.state);

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    host.replaceChildren();
  };
};
