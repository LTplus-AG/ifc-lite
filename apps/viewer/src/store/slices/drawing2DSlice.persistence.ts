/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * localStorage persistence for 2D drawing markup (issue #4153).
 *
 * Pure storage layer for `drawing2DSlice.ts` — kept in a sibling file rather
 * than inline because that slice is at its recorded module-size budget
 * (`scripts/module-size-allowlist.txt`), which only ratchets down.
 *
 * Mirrors `annotationsSlice.ts`'s pattern (versioned key, try/catch around
 * quota/parse errors, `console.warn` and continue, per-entry runtime
 * validation that skips malformed data rather than failing the whole load)
 * with one addition: markup is NOT global like the 3D pins, but keyed per
 * loaded file — a measurement is meaningless, or actively wrong, shown on
 * top of a DIFFERENT model.
 *
 * ## The scoping key
 * The key is the model's TRUE full-content hash
 * (`utils/sourceContentHash.ts`'s `computeFullSourceHashFromBlob`, SHA-256) —
 * NOT `hooks/sourceFingerprint.ts`'s window-sampled fingerprint, which has a
 * proven blind spot (an edit between its sample windows is invisible to it)
 * safe only where an mtime guard and a full-hash revalidation still gate a
 * false hit — guards this module lacks, so its key must be
 * collision-resistant on its own. Stable across reloads of the same file;
 * blind to the runtime `modelId`/`FederatedModel.id`, a fresh UUID every load.
 *
 * ## One localStorage key PER MODEL, not one shared blob (#4159 fix)
 * The first cut of this module kept every model's entry in a single JSON
 * object under one `localStorage` key. That made `readRaw()`'s "corrupt
 * JSON degrades to `{}` in memory" contract (below) into a cross-model
 * hazard: `JSON.parse` fails or succeeds for the WHOLE blob, so one bad byte
 * anywhere — a manual edit, a future version's bug, quota-adjacent
 * truncation — made every OTHER model's entry unreadable too, and the very
 * next `saveDrawing2DEntry()` call for an unrelated model would `writeRaw()`
 * the degraded `{}` back over the key, permanently deleting every model's
 * markup to save one. Splitting into `${STORAGE_KEY_PREFIX}${modelHash}` keys
 * makes that structurally impossible: reading or writing model A's entry
 * touches only A's key, so corruption under B's key can never be observed,
 * let alone overwritten, by anything A does.
 *
 * ## What is intentionally NOT here
 * `drawing2D` (the generated `Drawing2D`) is derived output — regenerable
 * from the persisted `sectionConfig` plus the loaded model, and far larger
 * than its inputs — so `PersistedDrawing2DEntry` has no field for it and
 * never will; see `drawing2DSlice.persistence.test.ts` for the test that
 * proves this. `dxfUnderlays` is deferred to a follow-up (IndexedDB — it
 * can embed arbitrary point counts, plausibly over `localStorage`'s ~5MB
 * synchronous budget); this module never touches it either.
 */

import type {
  CloudAnnotation2D,
  Drawing2DState,
  Measure2DResult,
  PolygonArea2DResult,
  Point2D,
  TextAnnotation2D,
} from './drawing2DSlice.js';
import { getDefaultDrawing2DState } from './drawing2DSlice.js';
import type { SectionConfig } from '@ifc-lite/drawing-2d';

/** The five store fields this module persists/restores/clears, as a plain patch. */
export type Drawing2DMarkupPatch = Pick<
  Drawing2DState,
  'measure2DResults' | 'polygonArea2DResults' | 'textAnnotations2D' | 'cloudAnnotations2D' | 'drawing2DDisplayOptions'
>;

/**
 * The markup patch a model should start from when it becomes active and
 * nothing says otherwise: the slice's own defaults. A pure function of no
 * arguments — no store, no `localStorage` — so both `modelSlice.ts`'s
 * `setActiveModel` (the atomic clear, #4159 Bug 2) and
 * `hooks/useDrawing2DPersistence.ts` (a redundant, defensive clear at the
 * top of its restore effect) can share ONE definition of "defaults" rather
 * than re-deriving it and risking the two silently drifting apart.
 */
export function defaultMarkupPatch(): Drawing2DMarkupPatch {
  const defaults = getDefaultDrawing2DState();
  return {
    measure2DResults: defaults.measure2DResults,
    polygonArea2DResults: defaults.polygonArea2DResults,
    textAnnotations2D: defaults.textAnnotations2D,
    cloudAnnotations2D: defaults.cloudAnnotations2D,
    drawing2DDisplayOptions: defaults.drawing2DDisplayOptions,
  };
}

/** Model ids whose latest `activeModelId` change carried an accompanying {@link defaultMarkupPatch} clear (`setActiveModel`) not yet skipped by the save subscription (#4159 Bug 4) — that clear looks like a real edit to a listener with no other context, so for an already-cached model it would overwrite the real entry with empty data. Keyed per model id, not a single boolean. */
const suppressedSaves = new Set<string>();

/** Marks `modelId`'s next save notification as the accompanying clear. Call inside the SAME atomic `set()`, before it notifies subscribers. */
export function suppressNextSaveFor(modelId: string): void {
  suppressedSaves.add(modelId);
}

/** Consumes (returns) `modelId`'s pending suppression — true at most once per mark, so a later genuine change to the same model still saves. */
export function consumeSuppressedSave(modelId: string): boolean {
  return suppressedSaves.delete(modelId);
}

/** One real `localStorage` key per model: `${STORAGE_KEY_PREFIX}${modelHash}`. */
const STORAGE_KEY_PREFIX = 'ifc-lite:drawing2d-markup:v1:';

/** Hard cap on distinct models remembered — oldest (by `savedAt`) evicted first. */
const MAX_ENTRIES = 20;

/** Exported for tests only — the real `localStorage` key a model's entry lives under. */
export function keyFor(modelHash: string): string {
  return `${STORAGE_KEY_PREFIX}${modelHash}`;
}

/** `true` for any real `localStorage` key this module owns. */
function isOwnKey(key: string | null): key is string {
  return key !== null && key.startsWith(STORAGE_KEY_PREFIX);
}

function hashFromKey(key: string): string {
  return key.slice(STORAGE_KEY_PREFIX.length);
}

export interface PersistedDrawing2DEntry {
  measure2DResults: Measure2DResult[];
  polygonArea2DResults: PolygonArea2DResult[];
  textAnnotations2D: TextAnnotation2D[];
  cloudAnnotations2D: CloudAnnotation2D[];
  drawing2DDisplayOptions: Drawing2DState['drawing2DDisplayOptions'];
  /** The `SectionConfig` that produced the view these results were drawn on, if any. */
  sectionConfig: SectionConfig | null;
  savedAt: number;
}

// ── Validation ───────────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPoint2D(v: unknown): v is Point2D {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return isFiniteNumber(p.x) && isFiniteNumber(p.y);
}

function isPoint2DArray(v: unknown): v is Point2D[] {
  return Array.isArray(v) && v.every(isPoint2D);
}

function isMeasure2DResult(v: unknown): v is Measure2DResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' && r.id.length > 0 &&
    isPoint2D(r.start) && isPoint2D(r.end) &&
    isFiniteNumber(r.distance)
  );
}

function isPolygonArea2DResult(v: unknown): v is PolygonArea2DResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' && r.id.length > 0 &&
    isPoint2DArray(r.points) && r.points.length >= 3 &&
    isFiniteNumber(r.area) && isFiniteNumber(r.perimeter)
  );
}

function isTextAnnotation2D(v: unknown): v is TextAnnotation2D {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === 'string' && a.id.length > 0 &&
    isPoint2D(a.position) &&
    typeof a.text === 'string' &&
    isFiniteNumber(a.fontSize) &&
    typeof a.color === 'string' &&
    typeof a.backgroundColor === 'string' &&
    typeof a.borderColor === 'string'
  );
}

function isCloudAnnotation2D(v: unknown): v is CloudAnnotation2D {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === 'string' && a.id.length > 0 &&
    isPoint2DArray(a.points) && a.points.length >= 2 &&
    typeof a.color === 'string' &&
    typeof a.label === 'string'
  );
}

/**
 * Validate + coalesce display options field-by-field over `fallback` rather
 * than all-or-nothing: a single corrupted toggle should not throw away the
 * user's scale / hidden-line preference alongside it.
 */
function coalesceDisplayOptions(
  v: unknown,
  fallback: Drawing2DState['drawing2DDisplayOptions'],
): Drawing2DState['drawing2DDisplayOptions'] {
  if (!v || typeof v !== 'object') return fallback;
  const o = v as Record<string, unknown>;
  const bool = (key: keyof Drawing2DState['drawing2DDisplayOptions']): boolean =>
    typeof o[key] === 'boolean' ? (o[key] as boolean) : (fallback[key] as boolean);
  const num = (key: keyof Drawing2DState['drawing2DDisplayOptions']): number =>
    isFiniteNumber(o[key]) ? (o[key] as number) : (fallback[key] as number);
  return {
    showHiddenLines: bool('showHiddenLines'),
    showHatching: bool('showHatching'),
    showAnnotations: bool('showAnnotations'),
    show3DOverlay: bool('show3DOverlay'),
    scale: num('scale'),
    useSymbolicRepresentations: bool('useSymbolicRepresentations'),
    showIfcAnnotations: bool('showIfcAnnotations'),
    showConstructionProjection: bool('showConstructionProjection'),
    showScanSection: bool('showScanSection'),
    scanSectionThickness: num('scanSectionThickness'),
    scanSectionOpacity: num('scanSectionOpacity'),
    scanSectionIncludeInExport: bool('scanSectionIncludeInExport'),
  };
}

/**
 * Loose structural check on a persisted `SectionConfig` — enough to catch
 * corruption without hand-validating every one of `drawing-2d`'s nested
 * plane-config variants. A config that fails this is dropped (`null`), which
 * only defers regeneration to a fresh section pick; it never blocks markup
 * restore.
 */
function isSectionConfigLike(v: unknown): v is SectionConfig {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  if (!c.plane || typeof c.plane !== 'object') return false;
  return (
    isFiniteNumber(c.projectionDepth) &&
    typeof c.includeHiddenLines === 'boolean' &&
    isFiniteNumber(c.creaseAngle) &&
    isFiniteNumber(c.scale)
  );
}

function isValidEntry(v: unknown): v is Omit<PersistedDrawing2DEntry, 'drawing2DDisplayOptions' | 'sectionConfig'> & {
  drawing2DDisplayOptions: unknown;
  sectionConfig: unknown;
} {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    isFiniteNumber(e.savedAt) &&
    Array.isArray(e.measure2DResults) &&
    Array.isArray(e.polygonArea2DResults) &&
    Array.isArray(e.textAnnotations2D) &&
    Array.isArray(e.cloudAnnotations2D)
  );
}

// ── Storage I/O ──────────────────────────────────────────────────────

/**
 * Read and parse ONE model's own `localStorage` key. A corrupt value under
 * THIS key degrades to `null` (skipped, never thrown) without touching, or
 * even looking at, any other key — the property that makes one model's
 * corruption unable to cascade into another's (#4159).
 */
function readEntryRaw(modelHash: string): unknown {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(keyFor(modelHash));
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[drawing2D] failed to read ${keyFor(modelHash)}`, err);
    return undefined;
  }
}

/** Returns whether the write actually landed, so a failed write never triggers eviction of someone else's good entry to make room for it. */
function writeEntryRaw(modelHash: string, entry: PersistedDrawing2DEntry): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(keyFor(modelHash), JSON.stringify(entry));
    return true;
  } catch (err) {
    // Quota exceeded / private mode — markup stays in memory but the
    // warning makes the failure debuggable, matching annotationsSlice.
    // eslint-disable-next-line no-console
    console.warn(`[drawing2D] failed to persist to ${keyFor(modelHash)}`, err);
    return false;
  }
}

function removeEntryRaw(modelHash: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(keyFor(modelHash));
  } catch {
    // Best-effort eviction; a failure here just means that entry lingers
    // past MAX_ENTRIES until the next successful write, not data loss.
  }
}

/**
 * Every `(modelHash, savedAt)` pair this module currently owns in
 * `localStorage`, read via `Storage.key(i)` rather than a maintained index —
 * there is no separate index to drift out of sync with the real keys. A key
 * whose value is corrupt is skipped (not evicted): eviction is an LRU policy
 * over readable entries, not a second corruption-recovery path — that stays
 * `readEntryRaw`'s / `loadDrawing2DEntry`'s job.
 */
function listOwnedEntries(): Array<{ modelHash: string; savedAt: number }> {
  if (typeof localStorage === 'undefined') return [];
  const out: Array<{ modelHash: string; savedAt: number }> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!isOwnKey(key)) continue;
    const modelHash = hashFromKey(key);
    const parsed = readEntryRaw(modelHash);
    if (isValidEntry(parsed)) out.push({ modelHash, savedAt: parsed.savedAt });
  }
  return out;
}

/**
 * Load the persisted markup for one model's content-hash key, or `null` when
 * there is nothing saved for it (a brand-new file) or the stored value for
 * that key is corrupt (skipped, never thrown).
 *
 * Given a `fallback` for `drawing2DDisplayOptions` — the slice's own current
 * defaults — so a partially-corrupt entry still restores what it validly can.
 */
export function loadDrawing2DEntry(
  modelHash: string,
  defaultDisplayOptions: Drawing2DState['drawing2DDisplayOptions'],
): PersistedDrawing2DEntry | null {
  const entry = readEntryRaw(modelHash);
  if (!isValidEntry(entry)) {
    if (entry !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(`[drawing2D] skipping malformed entry for model ${modelHash}`);
    }
    return null;
  }
  return {
    measure2DResults: entry.measure2DResults.filter(isMeasure2DResult),
    polygonArea2DResults: entry.polygonArea2DResults.filter(isPolygonArea2DResult),
    textAnnotations2D: entry.textAnnotations2D.filter(isTextAnnotation2D),
    cloudAnnotations2D: entry.cloudAnnotations2D.filter(isCloudAnnotation2D),
    drawing2DDisplayOptions: coalesceDisplayOptions(entry.drawing2DDisplayOptions, defaultDisplayOptions),
    sectionConfig: isSectionConfigLike(entry.sectionConfig) ? entry.sectionConfig : null,
    savedAt: entry.savedAt,
  };
}

/**
 * Save markup for one model's content-hash key — touching only that key —
 * then evict the oldest entries (by `savedAt`, across ALL owned keys) past
 * {@link MAX_ENTRIES} so `localStorage` cannot grow unbounded across many
 * different files opened over time. Eviction removes each loser's OWN key
 * directly; it never rewrites a shared blob, so it cannot lose an unrelated
 * model's entry the way the single-key design used to (#4159).
 */
export function saveDrawing2DEntry(
  modelHash: string,
  entry: Omit<PersistedDrawing2DEntry, 'savedAt'>,
): void {
  const savedAt = Date.now();
  const wrote = writeEntryRaw(modelHash, { ...entry, savedAt });
  // A failed write (quota / private mode) never reaches eviction: the new
  // entry is not actually in storage, so evicting someone else's valid entry
  // to make room for it would only trade good data for nothing.
  if (!wrote) return;

  const owned = listOwnedEntries();
  if (owned.length > MAX_ENTRIES) {
    owned
      .sort((a, b) => a.savedAt - b.savedAt)
      .slice(0, owned.length - MAX_ENTRIES)
      .forEach((e) => { removeEntryRaw(e.modelHash); });
  }
}

/** Test/diagnostic helper — not used by the persistence hook itself. */
export function clearAllDrawing2DEntries(): void {
  if (typeof localStorage === 'undefined') return;
  for (const { modelHash } of listOwnedEntries()) removeEntryRaw(modelHash);
  // `listOwnedEntries()` skips keys whose value is corrupt, so a prior test
  // or a real corrupted entry could otherwise survive a "clear everything"
  // call. Sweep raw key names too, independent of whether they parse.
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (isOwnKey(key)) stale.push(key);
  }
  stale.forEach((key) => localStorage.removeItem(key));
}
