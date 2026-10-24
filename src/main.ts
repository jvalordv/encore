/**
 * Entry point. Loads the stylesheets, fills the skin switcher from the
 * registry, applies the saved skin (Studio by default), then builds the
 * Session, hands it the pitch lane, mounts the UI on the markup in index.html
 * and starts the per-frame loop. Nothing needs a running service: the whole
 * practice loop (drop a song or paste a YouTube link, pick a mic, sing, see
 * the pitch) lives in the browser.
 *
 * Debug and test hook: `window.encore = { session, store }` is always set.
 * `session` is the Session (its intents, and `session.parts` for the audio
 * objects) and `store` is the StateStore the UI renders. This is a local app,
 * so there is nothing to protect; the end-to-end test drives the page through
 * it.
 */
import './skins/arcade.css';
import './skins/dreamhouse.css';
import './skins/studio.css';
import './style.css';
import { Session } from './app/session';
import type { StateStore } from './app/state';
import { mountUI } from './app/ui';
import { PitchLane } from './render/pitch-lane';
import { applySkin, loadSavedSkin, SKIN_EVENT, SKINS } from './skins';
import type { SkinEventDetail } from './skins';

/** Shape of `window.encore`. */
export interface EncoreGlobal {
  session: Session;
  store: StateStore;
}

declare global {
  interface Window {
    encore?: EncoreGlobal;
  }
}

function must<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`index.html is missing #${id}`);
  return e as T;
}

const switcher = must<HTMLSelectElement>('skin-switcher');
for (const skin of SKINS) {
  const option = document.createElement('option');
  option.value = skin.id;
  option.textContent = skin.name;
  option.title = skin.tagline;
  switcher.append(option);
}

// Apply before the lane exists so its first draw already uses the right skin.
switcher.value = applySkin(loadSavedSkin().id).id;
switcher.addEventListener('change', () => applySkin(switcher.value));
// Anything else that switches skin (shortcuts, settings) keeps the select true.
window.addEventListener(SKIN_EVENT, (ev) => {
  switcher.value = (ev as CustomEvent<SkinEventDetail>).detail.id;
});

const session = new Session();
const lane = new PitchLane(must<HTMLCanvasElement>('lane-canvas'), must('pitch-lane'));
session.attachLane(lane);
mountUI(session);
lane.start();
session.start();

window.encore = { session, store: session.store };
