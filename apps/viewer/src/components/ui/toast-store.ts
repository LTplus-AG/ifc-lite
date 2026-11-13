/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ─── Store (vanilla, framework-agnostic) ─────────────────────────────────

interface ToastAction { label: string; onClick: () => void; dismiss?: boolean }

export interface Toast {
  id: number;
  /** Dialog active when this notice was raised; earlier notices keep their anchor. */
  dialogId?: string;
  /** Only surfaces already open at emission may inherit a surviving notice. */
  dialogScopes: ReadonlySet<symbol>;
  /** A global operation lifecycle replaces earlier notices, even across surfaces. */
  key?: string;
  type: 'success' | 'error' | 'info';
  message: string;
  /** How many identical toasts were merged into this one. */
  count: number;
  /** Increases every time a toast is shown or merged into; orders by recency. */
  seq: number;
  action?: ToastAction | ToastAction[];
}

type Listener = () => void;

/** A burst of failures (e.g. repeated GPU device loss) must not bury the UI (#5603). */
const MAX_VISIBLE = 3;

let nextId = 0;
let nextSeq = 0;
let toasts: Toast[] = [];
const dialogs = new Map<string, { ancestors: readonly string[]; scope: symbol }>();

/** Registration is silent so Dialog can establish ownership before layout effects. */
export function registerToastDialog(id: string, ancestors: readonly string[]): () => void {
  dialogs.set(id, { ancestors, scope: Symbol(id) });
  return () => {
    dialogs.delete(id);
    // A nested dialog can close on success while its parent stays open. Keep
    // its notice readable there, but never adopt it into a later-opened modal.
    // Silent until Dialog's layout cleanup publishes the new snapshot.
    const reassigned = toasts.map(item => item.dialogId === id
      ? { ...item, dialogId: currentDialog(item.dialogScopes) } : item);
    // Independent unkeyed notices can now share an anchor. Coalesce before
    // the next emission enforces the cap, keeping the latest action/lifetime.
    toasts = reassigned.reduce<Toast[]>((kept, item) => {
      const previous = item.key === undefined ? kept.find(t => t.key === undefined
        && t.dialogId === item.dialogId && t.type === item.type && t.message === item.message) : undefined;
      if (!previous) return [...kept, item];
      // A transient duplicate must not give a persistent error an expiry.
      const survivorId = timers.has(previous.id) ? item.id : previous.id;
      clearTimer(survivorId === item.id ? previous.id : item.id);
      return [...kept.filter(t => t.id !== previous.id), { ...item, id: survivorId, count: previous.count + item.count }];
    }, []);
  };
}

function currentDialog(scopes?: ReadonlySet<symbol>): string | undefined {
  // React commits descendants before parents. Exclude covered ancestors first,
  // then let the most recently opened independent dialog own the notice.
  // Filter eligibility before ordering: a later ineligible surface must not
  // prevent a surviving notice from returning to an already-open parent.
  const eligible = [...dialogs].filter(([, dialog]) => !scopes || scopes.has(dialog.scope));
  const covered = new Set(eligible.flatMap(([, dialog]) => dialog.ancestors));
  let owner: string | undefined;
  for (const [id] of eligible) if (!covered.has(id)) owner = id;
  return owner;
}

/** Closing a dialog makes its surviving notifications available at the app anchor. */
export function refreshToastDialogs(): void {
  toasts = [...toasts];
  notify();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getToasts(): Toast[] { return toasts; }
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function notify() {
  for (const l of listeners) l();
}

function clearTimer(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
}

/**
 * Show a toast, or bump the count of an identical one already on screen and
 * make it the newest. `durationMs: null` keeps it until dismissed. Past
 * `MAX_VISIBLE` the oldest toasts are evicted, transient ones before errors:
 * an error stays until dismissed, so newer successes must not push it off.
 */
function addToast(type: Toast['type'], message: string, durationMs: number | null, action?: Toast['action'], key?: string): number {
  const dialogId = currentDialog();
  // Explicit keys identify an operation globally; unkeyed messages belong to a surface.
  // Closing dialogs can also bring formerly independent messages to the same anchor.
  const matching = toasts.filter((t) => key !== undefined ? t.key === key
    : t.dialogId === dialogId && t.key === undefined && t.type === type && t.message === message);
  const existing = matching.at(-1);
  const id = existing?.id ?? nextId++;
  const replaced = new Set(matching.map(t => t.id));
  const others = toasts.filter((t) => !replaced.has(t.id));
  const excess = Math.max(0, others.length - (MAX_VISIBLE - 1));
  // `others` is oldest-first, so this is oldest transient, then oldest error.
  const evictOrder = [...others.filter((t) => t.type !== 'error'), ...others.filter((t) => t.type === 'error')];
  const evicted = new Set(evictOrder.slice(0, excess).map((t) => t.id));
  for (const evictedId of evicted) clearTimer(evictedId);
  const kept = others.filter((t) => !evicted.has(t.id));
  toasts = [...kept, { id, dialogId, dialogScopes: new Set([...dialogs.values()].map(dialog => dialog.scope)), key, type, message, count: 1 + matching.filter(t => t.type === type && t.message === message).reduce((sum, t) => sum + t.count, 0), seq: nextSeq++, action }];
  for (const item of matching) clearTimer(item.id);
  if (durationMs !== null) timers.set(id, setTimeout(() => dismiss(id), durationMs));
  notify();
  return id;
}

export function dismiss(id: number) {
  clearTimer(id);
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

/** Imperative toast API. Errors stay until the user dismisses them. */
export const toast = {
  success: (message: string, action?: Toast['action'], key?: string): void => { addToast('success', message, action ? null : 3000, action, key); },
  error: (message: string, key?: string): void => { addToast('error', message, null, undefined, key); },
  info: (message: string, action?: Toast['action']): void => { addToast('info', message, action ? null : 3000, action); },
  /**
   * An error about an in-progress tool gesture, which means nothing once the
   * tool is gone (#6233): it dismisses itself after `durationMs`, and the
   * returned function dismisses it sooner (e.g. on tool exit).
   */
  transientError: (message: string, durationMs: number): (() => void) => {
    const id = addToast('error', message, durationMs);
    return () => dismiss(id);
  },
};

