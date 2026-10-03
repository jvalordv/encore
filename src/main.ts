/**
 * Entry point. Loads the stylesheets, fills the skin switcher from the
 * registry, applies the saved skin (Studio by default), creates the pitch
 * lane and reports readiness in the status bar. Later phases hang the audio
 * engine, tracker and state store off this file.
 */
import './skins/arcade.css';
import './skins/dreamhouse.css';
import './skins/studio.css';
import './style.css';
import { PitchLane } from './render/pitch-lane';
import { applySkin, loadSavedSkin, SKIN_EVENT, SKINS } from './skins';
import type { SkinEventDetail } from './skins';

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

// The lane redraws itself on resize and skin events, so nothing holds it yet.
new PitchLane(must<HTMLCanvasElement>('lane-canvas'), must('pitch-lane'));

must('statusbar').textContent = 'ready';
