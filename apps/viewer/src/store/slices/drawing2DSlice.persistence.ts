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
 * with one addition: markup is NOT global like the 3D pins. It is keyed per
 * loaded file, because a measurement is meaningless — or actively wrong —
 * shown on top of a DIFFERENT model.
 *
 * ## The scoping key
 * The key is the model's spread-sampled content fingerprint
 * (`hooks/sourceFingerprint.ts`'s `computeSourceFingerprintFromBlob`), the
 * SAME hash `services/ifc-cache.ts` already uses to key its cache entries —
 * reused here, not reinvented. It is stable across reloads of the same file
 * and (deliberately) blind to the runtime `modelId`/`FederatedModel.id`,
 * which is a fresh UUID every load and cannot serve as a persistence key.
 *
 * ## What is intentionally NOT here
 * `drawing2D` (the generated `Drawing2D`) is derived output — regenerable
 * from the persisted `sectionConfig` plus the loaded model, and far larger
 * than its inputs — so `PersistedDrawing2DEntry` has no field for it and
 * never will; see `drawing2DSlice.persistence.test.ts` for the test that
 * proves this. `dxfUnderlays` is deferred to a follow-up (IndexedDB — it can
 * embed arbitrary point counts, plausibly over `localStorage`'s ~5MB
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
import type { SectionConfig } from '@ifc-lite/drawing-2d';

const STORAGE_KEY = 'ifc-lite:drawing2d-markup:v1';

/** Hard cap on distinct models remembered — oldest (by `savedAt`) evicted first. */
const MAX_ENTRIES = 20;

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

type StorageShape = Record<string, PersistedDrawing2DEntry>;

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

function readRaw(): StorageShape {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as StorageShape;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[drawing2D] failed to read ${STORAGE_KEY}`, err);
    return {};
  }
}

function writeRaw(map: StorageShape): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (err) {
    // Quota exceeded / private mode — markup stays in memory but the
    // warning makes the failure debuggable, matching annotationsSlice.
    // eslint-disable-next-line no-console
    console.warn(`[drawing2D] failed to persist to ${STORAGE_KEY}`, err);
  }
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
  const all = readRaw();
  const entry = all[modelHash];
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
 * Save markup for one model's content-hash key, evicting the oldest entries
 * (by `savedAt`) past {@link MAX_ENTRIES} so localStorage cannot grow
 * unbounded across many different files opened over time.
 */
export function saveDrawing2DEntry(
  modelHash: string,
  entry: Omit<PersistedDrawing2DEntry, 'savedAt'>,
): void {
  const all = readRaw();
  all[modelHash] = { ...entry, savedAt: Date.now() };

  const keys = Object.keys(all);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => (all[a].savedAt ?? 0) - (all[b].savedAt ?? 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => { delete all[k]; });
  }

  writeRaw(all);
}

/** Test/diagnostic helper — not used by the persistence hook itself. */
export function clearAllDrawing2DEntries(): void {
  writeRaw({});
}
