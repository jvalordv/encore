/**
 * The Session's side of the remembered panel choices (src/app/ui-choices.ts):
 * it reads the record from the settings store at start, keeps `state.ui` and
 * the stored copy in step, and puts the whole record back to its defaults or to
 * an imported one. A choice that a controller also keeps in its own state (the
 * Library's list, the backing notes toggle) is written here by that controller
 * and applied back to it by `restore`, so there is one stored copy and the
 * controllers stay the ones that draw it. Panels read `state.ui` and call
 * `set`; they hold no copy of their own.
 */
import { DEFAULT_UI_CHOICES, UI_CHOICES_KEY, parseUiChoices, sanitizeUiChoices, serializeUiChoices } from '../ui-choices';
import type { UiChoices } from '../ui-choices';
import type { SessionCore } from './core';

/** Owns the remembered panel choices. */
export class UiChoicesController {
  constructor(private readonly core: SessionCore) {
    core.store.patch({ ui: parseUiChoices(core.settingsStore.get(UI_CHOICES_KEY)) });
  }

  /** The choices now in force. */
  get(): UiChoices {
    return this.core.store.state.ui;
  }

  /**
   * Changes some choices and remembers them. A field with an invalid value is
   * ignored, so a caller cannot store what a reload would throw away.
   */
  set(patch: Partial<UiChoices>): void {
    const current = this.get();
    const next = sanitizeUiChoices(patch, current);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    this.write(next);
  }

  /** Puts every choice back to its default (Reset all). */
  reset(): void {
    this.replace(sanitizeUiChoices(null));
  }

  /**
   * Makes `next` the choices, in the store, the state and the controllers that
   * keep a copy (the Library's list and the backing notes toggle). An import
   * and Reset all use this.
   */
  replace(next: UiChoices): void {
    const safe = sanitizeUiChoices(next, DEFAULT_UI_CHOICES);
    this.write(safe);
    this.core.library.setView(safe.libraryView);
    this.core.backing.setShown(safe.backingShown);
  }

  private write(next: UiChoices): void {
    this.core.settingsStore.set(UI_CHOICES_KEY, serializeUiChoices(next));
    this.core.store.patch({ ui: next });
  }
}
