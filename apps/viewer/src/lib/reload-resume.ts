/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Carry "which local models were open" across a stale-deployment reload.
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
 * bytes are not cached.
 *
 * WHAT is carried is read at reload time from the models actually in the
 * viewer, never from a running record of load calls: a model the user closed,
 * a load that failed for its own reasons, or a federation replaced by a fresh
 * one must not come back. Two filters apply:
 * - only a model whose source `File` the user opened from their own disk
 *   ({@link markLocalModelFiles}): a model fetched from a `?model=` URL or a
 *   cloud source is not "reopen it from your disk", and a cached local file
 *   that happens to share its name would load a different model;
 * - a model in `loadState: 'error'` only when that error WAS the stale
 *   deployment ({@link noteStaleDeploymentLoadFailure}), which is exactly the
 *   load this module exists to resume.
 *
 * Names stay in this tab's sessionStorage. Nothing here reaches analytics.
 *
 * Loop guard. A reload this module triggers automatically is already bounded
 * per tab by its caller's debounce; the reopen is bounded here as well, because
 * a reopen that fails slowly could otherwise outlast that debounce and cycle
 * load -> fail -> reload -> reopen forever. An AUTOMATIC reload within
 * {@link AUTO_REOPEN_COOLDOWN_MS} of an automatic reopen persists the names
 * with `reopen: false`, so the next boot asks instead of loading. A reload the
 * user clicked always reopens, and a later deployment, after the cooldown,
 * reopens automatically again.
 */

const KEY = 'ifclite:reload-resume';
/** A stored intent older than this is ignored: it belongs to some other reload. */
const MAX_AGE_MS = 2 * 60_000;
/** After an automatic reopen, a further automatic reload only prompts for this long. */
export const AUTO_REOPEN_COOLDOWN_MS = 10 * 60_000;
const MAX_FILES = 5;

export type ReloadTrigger = 'automatic' | 'user';

export interface ResumeIntent {
  /** File names, in load order. The first was the primary model. */
  files: string[];
  /** Reopen from the blob cache without asking (false: only prompt). */
  reopen: boolean;
}

/** What the reload needs to know about one model in the viewer. */
export interface OpenModelSnapshot {
  sourceFile?: File;
  loadState?: string;
}

const localFiles = new WeakSet<File>();
const staleFailures = new WeakSet<File>();
let lastAutoReopenAt: number | null = null;
let readOpenModels: () => Iterable<OpenModelSnapshot> = () => [];

/** Mark files the user opened from their own disk (picker, drop, recent-files cache). */
export function markLocalModelFiles(files: Iterable<File>): void {
  for (const file of files) localFiles.add(file);
}

/** The load of `file` failed because this tab's deployment is gone: resume it after the reload. */
export function noteStaleDeploymentLoadFailure(file: File): void {
  staleFailures.add(file);
}

/** Wire the source of truth: the viewer's loaded models (set once by the viewer). */
export function setOpenModelsSource(read: () => Iterable<OpenModelSnapshot>): void {
  readOpenModels = read;
}

/** Names of the local models to bring back, from the models the viewer holds now. */
export function resumableFileNames(models: Iterable<OpenModelSnapshot>): string[] {
  const names: string[] = [];
  for (const model of models) {
    const file = model.sourceFile;
    if (!file || !localFiles.has(file)) continue;
    if (model.loadState === 'error' && !staleFailures.has(file)) continue;
    if (!names.includes(file.name)) names.push(file.name);
  }
  return names.slice(0, MAX_FILES);
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

/** Write the open local models so the next boot can restore them. Best effort: a blocked store just loses the resume. */
export function persistResumeIntent(trigger: ReloadTrigger, deps: PersistDeps = defaultDeps()): void {
  if (!deps.storage) return;
  const files = resumableFileNames(readOpenModels());
  if (files.length === 0) return;
  const now = deps.now();
  const inCooldown = lastAutoReopenAt !== null && now - lastAutoReopenAt >= 0 && now - lastAutoReopenAt < AUTO_REOPEN_COOLDOWN_MS;
  const reopen = trigger === 'user' || !inCooldown;
  try {
    deps.storage.setItem(KEY, JSON.stringify({ files, at: now, reopen }));
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
  const now = deps.now();
  const elapsed = now - Number(at);
  // A future stamp (clock change) is as untrustworthy as an old one.
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > MAX_AGE_MS) return null;
  if (!Array.isArray(files)) return null;
  const names = files.filter((f): f is string => typeof f === 'string' && f.length > 0).slice(0, MAX_FILES);
  if (names.length === 0) return null;
  const intent = { files: names, reopen: reopen === true };
  if (intent.reopen) lastAutoReopenAt = now;
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

/** Test-only. Files are weakly held, so tests use fresh `File` objects instead of clearing the sets. */
export function __resetReloadResumeForTests(): void {
  lastAutoReopenAt = null;
  readOpenModels = () => [];
}
