/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Portable federation setup file (issue #3930): lets a user save which
 * models make up a federation — load order, visibility, and which model is
 * the alignment anchor — and reopen that setup later, possibly on a
 * different machine, matching the saved slots back to local files.
 *
 * ## What the file references, versus embeds
 * The file stores each model's original filename, byte size, and a content
 * fingerprint (`computeSourceFingerprint`, the same sampled 64-bit hash used
 * to key the geometry cache). It never embeds file bytes, an absolute path,
 * a `FileSystemFileHandle`, or any credential — reopening it always requires
 * the user to (re-)select the actual model files, which is what keeps the
 * file small and portable across machines. See `matchFederationSetupSlots`.
 *
 * ## Alignment is replayed, not baked in
 * Rather than serialize per-model transform matrices (which would silently
 * go stale the moment a matched file's own IFC georeferencing differs from
 * the original), the file records only WHICH slot was the federation anchor.
 * On reopen, the caller re-adds every matched model through the normal
 * `addModel` load path and then calls `realignFederation()` against the
 * restored anchor — the exact same alignment logic a fresh multi-file load
 * would run. This keeps the saved file simple and guarantees alignment
 * always reflects the actual (possibly updated) georeferencing of the files
 * being opened, matching the codebase's existing single alignment pipeline
 * (`useIfcFederation.realignFederation`) instead of forking a second one.
 *
 * ## Determinism
 * `buildFederationSetupFile` takes models as an ARRAY in federation load
 * order (the caller passes `Array.from(models.values())`, which is a Map's
 * insertion order — the order models were actually added, never re-sorted
 * here). The serialized JSON's key order is fixed by explicit object
 * construction (never a spread of an arbitrary object), so saving the same
 * federation state twice produces byte-identical output — no hash-map
 * iteration ordering and no embedded timestamp to make two saves differ.
 *
 * ## Model tags (format 2, issue #4215)
 * Format 2 adds the user's model tags: `tags` declares the definitions the
 * slots use (id, name, colour — ONLY tags some slot carries, sorted by id, so
 * the file describes this federation and not the whole browser vocabulary),
 * and each slot lists its `tagIds`. Ids are kept verbatim so a saved advanced
 * filter or clash preset that names a tag id still resolves after a reopen on
 * another machine. Format 1 files read as format 2 with no tags.
 */

import { computeSourceFingerprint } from '../../hooks/sourceFingerprint.js';
import type { FederatedModel } from '../../store/types.js';
import type { ModelTag } from '../model-tags/types.js';
import { parseModelTag } from '../model-tags/persistence.js';

/** Current on-disk format version. Bump on any breaking shape change. */
export const FEDERATION_SETUP_FORMAT_VERSION = 2;
/** Every version `parseFederationSetupFile` still reads. */
const READABLE_FORMAT_VERSIONS: readonly number[] = [1, FEDERATION_SETUP_FORMAT_VERSION];

/** One saved model slot: what is needed to find the file again and restore its state. */
export interface FederationSetupSlot {
  /** Original filename at save time (display + fallback matching key). */
  name: string;
  /** Original file size in bytes. */
  fileSize: number;
  /**
   * Content fingerprint (`computeSourceFingerprint(...).hex`) of the source
   * file, or `null` when the model's source bytes were not available at
   * save time (e.g. a model restored from cache without its original File).
   * A `null` fingerprint degrades matching to name/size only.
   */
  fingerprintHex: string | null;
  /** Model-level visibility at save time. */
  visible: boolean;
  /** Hierarchy-panel collapse state at save time. */
  collapsed: boolean;
  /** True for exactly one slot: the federation's alignment anchor. */
  anchor: boolean;
  /** Model tag ids on this model (#4215); each is declared in `FederationSetupFile.tags`. */
  tagIds: string[];
}

/** A complete, versioned, portable federation setup. */
export interface FederationSetupFile {
  formatVersion: typeof FEDERATION_SETUP_FORMAT_VERSION;
  /** Tag definitions the slots reference, sorted by id (#4215). */
  tags: ModelTag[];
  /** Slots in federation load order. */
  slots: FederationSetupSlot[];
}

/** The live tag state `buildFederationSetupFile` reads (structural: the slice's two maps). */
export interface FederationSetupTagState {
  modelTags: ReadonlyMap<string, ModelTag>;
  modelTagAssignments: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Compute the content fingerprint of a `File`'s current bytes. */
export async function computeFileFingerprint(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return computeSourceFingerprint(buffer).hex;
}

/**
 * Build a {@link FederationSetupFile} from the live federation state.
 *
 * @param models - Models in federation load order (`Array.from(models.values())`).
 * @param anchorModelId - The id of the model currently acting as the
 *   alignment anchor (the "effective anchor", not necessarily the pinned
 *   override — see `findReferenceGeorefModel`), or `null` if none.
 * @param tagState - Tag definitions + assignments; omit for a tagless file.
 */
export async function buildFederationSetupFile(
  models: readonly FederatedModel[],
  anchorModelId: string | null,
  tagState?: FederationSetupTagState,
): Promise<FederationSetupFile> {
  const used = new Map<string, ModelTag>();
  const slots: FederationSetupSlot[] = await Promise.all(
    models.map(async (model) => {
      const fingerprintHex = model.sourceFile
        ? await computeFileFingerprint(model.sourceFile)
        : null;
      // Only ids with a live definition: an assignment whose tag was deleted
      // has nothing to declare, and a reader would (rightly) refuse it.
      const tagIds: string[] = [];
      for (const id of [...(tagState?.modelTagAssignments.get(model.id) ?? [])].sort()) {
        const tag = tagState?.modelTags.get(id);
        if (!tag) continue;
        tagIds.push(id);
        used.set(id, tag);
      }
      return {
        name: model.name,
        fileSize: model.fileSize,
        fingerprintHex,
        visible: model.visible,
        collapsed: model.collapsed,
        anchor: model.id === anchorModelId,
        tagIds,
      };
    }),
  );
  const tags = [...used.keys()].sort().map((id) => canonicalTag(used.get(id) as ModelTag));
  return { formatVersion: FEDERATION_SETUP_FORMAT_VERSION, tags, slots };
}

/** Fixed key order, no stray fields — what makes two saves byte-identical. */
function canonicalTag(tag: ModelTag): ModelTag {
  return { id: tag.id, name: tag.name, ...(tag.color ? { color: tag.color } : {}) };
}

/** Serialize a setup to its canonical on-disk JSON text (stable key order, 2-space indent). */
export function serializeFederationSetupFile(setup: FederationSetupFile): string {
  const canonical: FederationSetupFile = {
    formatVersion: setup.formatVersion,
    tags: setup.tags.map(canonicalTag),
    slots: setup.slots.map((slot) => ({
      name: slot.name,
      fileSize: slot.fileSize,
      fingerprintHex: slot.fingerprintHex,
      visible: slot.visible,
      collapsed: slot.collapsed,
      anchor: slot.anchor,
      tagIds: [...slot.tagIds],
    })),
  };
  return JSON.stringify(canonical, null, 2);
}

export type FederationSetupParseResult =
  | { ok: true; setup: FederationSetupFile }
  | { ok: false; error: string };

/**
 * Parse and strictly validate a federation setup file. Fails loudly (returns
 * `ok: false` with a specific reason) on anything malformed rather than
 * silently coercing or dropping fields — an unreadable field here must not
 * be mistaken for "restored fully".
 */
export function parseFederationSetupFile(raw: string): FederationSetupParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, error: 'Expected a JSON object at the top level.' };
  }
  const obj = json as Record<string, unknown>;

  if (typeof obj.formatVersion !== 'number' || !READABLE_FORMAT_VERSIONS.includes(obj.formatVersion)) {
    return {
      ok: false,
      error: `Unsupported federation setup version: ${JSON.stringify(obj.formatVersion)} (expected ${READABLE_FORMAT_VERSIONS.join(' or ')}).`,
    };
  }
  const tagsResult = parseSetupTags(obj.formatVersion, obj.tags);
  if (!tagsResult.ok) return tagsResult;
  const tags = tagsResult.tags;
  const declaredTagIds = new Set(tags.map((t) => t.id));
  if (!Array.isArray(obj.slots)) {
    return { ok: false, error: '"slots" must be an array.' };
  }
  if (obj.slots.length === 0) {
    return { ok: false, error: 'A federation setup with zero model slots is not valid.' };
  }

  const slots: FederationSetupSlot[] = [];
  let anchorCount = 0;
  for (let i = 0; i < obj.slots.length; i++) {
    const raw = obj.slots[i];
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: `slots[${i}] is not an object.` };
    }
    const s = raw as Record<string, unknown>;
    if (typeof s.name !== 'string' || s.name.length === 0) {
      return { ok: false, error: `slots[${i}].name must be a non-empty string.` };
    }
    if (typeof s.fileSize !== 'number' || !Number.isFinite(s.fileSize) || s.fileSize < 0) {
      return { ok: false, error: `slots[${i}].fileSize must be a non-negative number.` };
    }
    if (s.fingerprintHex !== null && typeof s.fingerprintHex !== 'string') {
      return { ok: false, error: `slots[${i}].fingerprintHex must be a string or null.` };
    }
    if (typeof s.visible !== 'boolean') {
      return { ok: false, error: `slots[${i}].visible must be a boolean.` };
    }
    if (typeof s.collapsed !== 'boolean') {
      return { ok: false, error: `slots[${i}].collapsed must be a boolean.` };
    }
    if (typeof s.anchor !== 'boolean') {
      return { ok: false, error: `slots[${i}].anchor must be a boolean.` };
    }
    if (s.anchor) anchorCount += 1;
    const tagIds = parseSlotTagIds(obj.formatVersion, s.tagIds, declaredTagIds);
    if (typeof tagIds === 'string') return { ok: false, error: `slots[${i}].tagIds ${tagIds}` };
    slots.push({
      name: s.name,
      fileSize: s.fileSize,
      fingerprintHex: s.fingerprintHex as string | null,
      visible: s.visible,
      collapsed: s.collapsed,
      anchor: s.anchor,
      tagIds,
    });
  }
  if (anchorCount > 1) {
    return { ok: false, error: `Exactly one slot may be the anchor; found ${anchorCount}.` };
  }

  return { ok: true, setup: { formatVersion: FEDERATION_SETUP_FORMAT_VERSION, tags, slots } };
}

/** Format 1 has no tags; format 2 must declare a well-formed, id-unique list. */
function parseSetupTags(formatVersion: number, raw: unknown): { ok: true; tags: ModelTag[] } | { ok: false; error: string } {
  if (formatVersion === 1) return { ok: true, tags: [] };
  if (!Array.isArray(raw)) return { ok: false, error: '"tags" must be an array.' };
  const tags: ModelTag[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const tag = parseModelTag(raw[i]);
    if (!tag) return { ok: false, error: `tags[${i}] must be { id, name, color? } with non-empty id and name.` };
    if (ids.has(tag.id)) return { ok: false, error: `tags[${i}] repeats the id ${JSON.stringify(tag.id)}.` };
    ids.add(tag.id);
    tags.push(tag);
  }
  return { ok: true, tags };
}

/** A slot's tag ids, or the reason (as a string) they are unreadable. Every id must be declared. */
function parseSlotTagIds(formatVersion: number, raw: unknown, declared: ReadonlySet<string>): string[] | string {
  if (formatVersion === 1) return [];
  if (!Array.isArray(raw) || !raw.every((t) => typeof t === 'string')) return 'must be an array of strings.';
  const undeclared = (raw as string[]).find((t) => !declared.has(t));
  if (undeclared !== undefined) return `references an undeclared tag ${JSON.stringify(undeclared)}.`;
  return [...new Set(raw as string[])];
}

/** How confidently a local file was matched back to a saved slot. */
export type FederationSetupMatchConfidence = 'content' | 'name-size' | 'name-only' | 'none';

export interface FederationSetupSlotMatch {
  slot: FederationSetupSlot;
  slotIndex: number;
  /** The local file matched to this slot, or `null` when nothing matched (missing). */
  file: File | null;
  confidence: FederationSetupMatchConfidence;
}

/**
 * Match saved slots to a set of freshly-picked local files. One-to-one:
 * a given local file is consumed by at most one slot, so two saved slots
 * that happen to share a filename never both grab the same file — each
 * pass below only assigns from files not already consumed by an earlier,
 * higher-confidence pass or an earlier slot in the same pass.
 *
 * Pass order (highest confidence first):
 *   1. content: fingerprint match (exact bytes, robust to a rename)
 *   2. name-size: same filename AND same byte size (fingerprint unknown/absent)
 *   3. name-only: same filename only (size differs) — flagged, likely a
 *      same-name-different-content collision; still offered so the user can
 *      decide, never auto-applied silently
 *   4. none: no candidate left — reported as missing
 */
export async function matchFederationSetupSlots(
  setup: FederationSetupFile,
  files: readonly File[],
): Promise<FederationSetupSlotMatch[]> {
  const candidates = await Promise.all(
    files.map(async (file, index) => ({
      index,
      file,
      fingerprintHex: await computeFileFingerprint(file),
    })),
  );
  const used = new Set<number>();

  const results: (FederationSetupSlotMatch | undefined)[] = new Array(setup.slots.length);

  // Pass 1: content fingerprint.
  setup.slots.forEach((slot, slotIndex) => {
    if (!slot.fingerprintHex) return;
    const match = candidates.find((c) => !used.has(c.index) && c.fingerprintHex === slot.fingerprintHex);
    if (match) {
      used.add(match.index);
      results[slotIndex] = { slot, slotIndex, file: match.file, confidence: 'content' };
    }
  });

  // Pass 2: name + size.
  setup.slots.forEach((slot, slotIndex) => {
    if (results[slotIndex]) return;
    const match = candidates.find(
      (c) => !used.has(c.index) && c.file.name === slot.name && c.file.size === slot.fileSize,
    );
    if (match) {
      used.add(match.index);
      results[slotIndex] = { slot, slotIndex, file: match.file, confidence: 'name-size' };
    }
  });

  // Pass 3: name only (content/size differs — a real collision or a stale file).
  setup.slots.forEach((slot, slotIndex) => {
    if (results[slotIndex]) return;
    const match = candidates.find((c) => !used.has(c.index) && c.file.name === slot.name);
    if (match) {
      used.add(match.index);
      results[slotIndex] = { slot, slotIndex, file: match.file, confidence: 'name-only' };
    }
  });

  // Pass 4: missing.
  setup.slots.forEach((slot, slotIndex) => {
    if (results[slotIndex]) return;
    results[slotIndex] = { slot, slotIndex, file: null, confidence: 'none' };
  });

  return results as FederationSetupSlotMatch[];
}

/** Outcome classification for a batch of {@link FederationSetupSlotMatch}es, before anything is applied. */
export interface FederationSetupMatchSummary {
  total: number;
  /** Matched with high confidence (content, or name+size) — safe to restore without asking. */
  resolved: FederationSetupSlotMatch[];
  /** Same filename but different size/content — offered, but the user should confirm. */
  mismatched: FederationSetupSlotMatch[];
  /** No candidate file found at all. */
  missing: FederationSetupSlotMatch[];
}

/** Pure classification of match results — used both by the review UI and by tests. */
export function summarizeFederationSetupMatches(matches: readonly FederationSetupSlotMatch[]): FederationSetupMatchSummary {
  const resolved = matches.filter((m) => m.confidence === 'content' || m.confidence === 'name-size');
  const mismatched = matches.filter((m) => m.confidence === 'name-only');
  const missing = matches.filter((m) => m.confidence === 'none');
  return { total: matches.length, resolved, mismatched, missing };
}
