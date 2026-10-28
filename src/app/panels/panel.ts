/**
 * The shape of a UI panel. Each panel lives in its own file under
 * src/app/panels/ and exports one mount function that takes the element it
 * owns plus the Session and the state store (whatever it needs, and no more)
 * and returns a dispose that removes every listener and subscription it added.
 * ui.ts only composes: it mounts the panels and calls their disposers. New UI
 * goes in a panel; existing UI stays in ui.ts until a wave has reason to move
 * it.
 */

/** Removes everything a mounted panel added: listeners, subscriptions, nodes. */
export type PanelDispose = () => void;

/** A panel's mount function: builds into `host`, returns its dispose. */
export type MountPanel<Deps> = (host: HTMLElement, deps: Deps) => PanelDispose;
