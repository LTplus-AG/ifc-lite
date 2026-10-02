/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Carry "which model was open" across a stale-deployment reload.
 *
 * A tab that outlives its deployment (production deploys several times a day;
 * Skew Protection keeps an old build's assets for 7 days, and only while the
 * per-build `__vdpl` pin cookie is present) loses its geometry worker, engine
 * binary or lazy chunks, and the only fix is a reload (./wasm-version-skew.ts,
 * ./chunk-version-skew.ts, ./stale-deployment.ts). A reload discards the
 * model, so the user used to land on an empty viewer with no explanation, the
 * file they had just opened gone. Here the open file NAMES ride the reload in
 * sessionStorage, and on boot the viewer reopens them from the recent-files
 * blob cache (./recent-files.ts), or asks the user to reopen them when the
 * bytes are not cached (too large, or opened from somewhere that is not cached).
 *
 * Names stay in this tab's sessionStorage. Nothing here reaches analytics.
 *
 * Loop guard. A reload this module triggers automatically is already bounded
 * per tab by its caller's debounce; the reopen is bounded here as well, because
 * a reopen that fails slowly could otherwise outlast that debounce and cycle
 * load -> fail -> reload -> reopen forever. An AUTOMATIC reload issued by a
 * page that was itself an automatic reopen persists the names with
 * `reopen: false`, so the next boot asks instead of loading. A reload the user
 * clicked always reopens: each cycle then costs a click.
 */

const KEY = 'ifclite:reload-resume';
/** A stored intent older than this is ignored: it belongs to some other reload. */
const MAX_AGE_MS = 2 * 60_000;
const MAX_FILES = 5;

export type ReloadTrigger = 'automatic' | 'user';

export interface ResumeIntent {
  /** File names, in load order. The first was the primary model. */
  files: string[];
  /** Reopen from the blob cache without asking (false: only prompt). */
  reopen: boolean;
}

let openFiles: string[] = [];
let resumedThisPage = false;

/**
 * Record a model load, from the one canonical load path. A primary load
 * replaces the set; a federated add joins it.
 */
export function noteModelLoadIntent(fileName: string, kind: 'primary' | 'federated'): void {
  if (kind === 'primary') openFiles = [fileName];
  else if (!openFiles.includes(fileName)) openFiles = [...openFiles, fileName].slice(-MAX_FILES);
}

let hasOpenModels: () => boolean = () => true;

/**
 * Let the viewer say whether anything is open or loading right now, so a reload
 * after the user closed every model does not bring them back.
 */
export function setOpenModelsProbe(probe: () => boolean): void {
  hasOpenModels = probe;
}

export interface PersistDeps {
  now: () => number;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

function sessionStorageOrNull(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // Accessing the property itself throws in a sandboxed frame.
    return null;
  }
}

const defaultDeps = (): PersistDeps => ({ now: () => Date.now(), storage: sessionStorageOrNull() });

/** Write the open set so the next boot can restore it. Best effort: a blocked store just loses the resume. */
export function persistResumeIntent(trigger: ReloadTrigger, deps: PersistDeps = defaultDeps()): void {
  if (openFiles.length === 0 || !deps.storage || !hasOpenModels()) return;
  const reopen = trigger === 'user' || !resumedThisPage;
  try {
    deps.storage.setItem(KEY, JSON.stringify({ files: openFiles, at: deps.now(), reopen }));
  } catch (err) {
    console.warn('[reload-resume] could not remember the open models across the reload', err);
  }
}

/** Read and REMOVE the stored intent (one-shot), or null when there is none or it is stale. */
export function takeResumeIntent(deps: PersistDeps = defaultDeps()): ResumeIntent | null {
  if (!deps.storage) return null;
  let raw: string | null;
  try {
    raw = deps.storage.getItem(KEY);
    if (raw === null) return null;
    deps.storage.removeItem(KEY);
  } catch (err) {
    console.warn('[reload-resume] could not read the stored resume intent', err);
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { files, at, reopen } = parsed as { files?: unknown; at?: unknown; reopen?: unknown };
  const elapsed = deps.now() - Number(at);
  // A future stamp (clock change) is as untrustworthy as an old one.
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > MAX_AGE_MS) return null;
  if (!Array.isArray(files)) return null;
  const names = files.filter((f): f is string => typeof f === 'string' && f.length > 0).slice(0, MAX_FILES);
  if (names.length === 0) return null;
  const intent = { files: names, reopen: reopen === true };
  if (intent.reopen) resumedThisPage = true;
  return intent;
}

/**
 * Reload the tab onto the current deployment, keeping the open models.
 * `trigger` says whether a person asked for it (see the loop guard above).
 */
export function reloadKeepingOpenModels(trigger: ReloadTrigger, reload: () => void = () => window.location.reload()): void {
  persistResumeIntent(trigger);
  reload();
}

/** Test-only. */
export function __resetReloadResumeForTests(): void {
  openFiles = [];
  resumedThisPage = false;
  hasOpenModels = () => true;
}
