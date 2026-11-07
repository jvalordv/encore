/**
 * The skin as the Settings panel sees it: the registry's skins, the one in
 * force, a way to change it and a way to hear that something else did (the
 * header's switcher fires the same `encore:skin` event). The skin lives in
 * the page (data-skin and its own storage key, read before any script runs),
 * not in the Session, so this is the one bridge. Importing touches no DOM.
 */
import { applySkin, DEFAULT_SKIN, loadSavedSkin, SKIN_EVENT, SKINS } from '../skins';
import type { SkinPort } from './panels/settings';

/** A SkinPort over the page's skin registry, listening on `win`. */
export function domSkinPort(win: Window): SkinPort {
  return {
    choices: SKINS.map((skin) => [skin.id, skin.name] as const),
    defaultId: DEFAULT_SKIN.id,
    current: () => loadSavedSkin().id,
    set: (id) => void applySkin(id),
    onChange(cb) {
      win.addEventListener(SKIN_EVENT, cb);
      return () => win.removeEventListener(SKIN_EVENT, cb);
    },
  };
}
