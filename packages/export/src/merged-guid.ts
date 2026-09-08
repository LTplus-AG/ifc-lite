/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GlobalId reading, minting and re-stamping for the merged exporter — the JS
 * twin of `rust/export/src/merged/guid.rs`.
 *
 * Split out of `merged-exporter.ts` (none of it used `this`) so the rules for
 * recognising and reconciling an `IfcGloballyUniqueId` live in one module rather
 * than inside the merge loop.
 */

import { deterministicGlobalId, getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import type { IfcSourceBytes } from '@ifc-lite/parser';
import { asSourceBytes } from '@ifc-lite/parser';
import type { ExportEntityRef } from './entity-iteration.js';

/**
 * An IfcGloballyUniqueId is exactly 22 characters of the buildingSMART base64
 * alphabet. We use this to recognise a rooted entity (IfcRoot subtype) by its
 * first attribute. Geometry/list entities never carry a string there, but some
 * non-rooted RESOURCE entities lead with a Name/Identifier string that can
 * legitimately be 22 charset chars (e.g. a coded property key). Those are
 * excluded with a schema-derived rootedness check ({@link isRootedType}) so
 * their Name is never mistaken for a GlobalId — otherwise the GlobalId
 * reconciliation could drop or rename them.
 */
const GLOBAL_ID_RE = /^[0-9A-Za-z_$]{22}$/;

/**
 * Whether `type` is an IfcRoot subtype — a schema-derived replacement for a
 * hand-maintained denylist of "non-rooted types whose first attribute happens
 * to be a string". A denylist has to be told about every such type by hand and
 * silently under-covers as the schema grows — `IfcMaterialProfileWithOffsets`
 * and several other resource types were missing and got their leading Name
 * treated as a GlobalId, corrupting ordinary model data on a collision.
 *
 * `getInheritanceChainAcrossSchemas` walks the bundled IFC2X3/IFC4/IFC4X3
 * schema union to the entity's root ancestor; a rooted entity's chain always
 * ends in `IfcRoot`. This mirrors the Rust side's `IfcType::is_subtype_of`
 * schema check, so the two implementations of "is this rooted" agree instead
 * of drifting apart as separate hand-maintained lists.
 *
 * A type unknown to every bundled schema (typo, vendor extension) yields an
 * empty chain and is treated as non-rooted — the same safe-miss direction the
 * old denylist documented: it just skips one GlobalId reconciliation.
 */
export function isRootedType(type: string): boolean {
  return getInheritanceChainAcrossSchemas(type).includes('IfcRoot');
}

/**
 * Read the GlobalId (first quoted attribute) from an already-rendered STEP
 * line. Used to register the id that was actually emitted, after any id
 * remap, GlobalId re-stamp, or schema conversion. Returns null if the first
 * quoted token is not a 22-char GlobalId.
 */
export function readLeadingGuid(entityText: string): string | null {
  const open = entityText.indexOf('(');
  if (open === -1) return null;
  const q1 = entityText.indexOf("'", open + 1);
  if (q1 === -1) return null;
  const q2 = entityText.indexOf("'", q1 + 1);
  if (q2 === -1) return null;
  const raw = entityText.slice(q1 + 1, q2);
  return GLOBAL_ID_RE.test(raw) ? raw : null;
}

/**
 * Mint a fresh, deterministic, collision-free GlobalId for an entity whose id
 * collides. Seeded from the original GlobalId and the model's stable id so the
 * output is reproducible and does not churn when an unrelated earlier model
 * changes size; checked against both already-emitted ids and the ids minted
 * so far for this model.
 */
export function mintUniqueGuid(
  original: string,
  modelId: string,
  emitted: ReadonlyMap<string, unknown>,
  pendingMinted: Set<string>,
): string {
  let candidate = deterministicGlobalId(`${original}#${modelId}`);
  let n = 0;
  while (emitted.has(candidate) || pendingMinted.has(candidate)) {
    candidate = deterministicGlobalId(`${original}#${modelId}#${n++}`);
  }
  pendingMinted.add(candidate);
  return candidate;
}

/**
 * Read an entity's GlobalId (first attribute) by decoding only its head.
 * Returns the 22-char id for a rooted entity, or `null` for any entity whose
 * first attribute is not a GlobalId (geometry, lists, property atoms, …).
 */
export function extractGlobalIdFast(
  ref: ExportEntityRef,
  source: Uint8Array | IfcSourceBytes,
): string | null {
  // Non-rooted resource entities (property/quantity/material/style/actor …)
  // lead with a Name string that can itself be 22 charset chars; never treat
  // those as a GlobalId or reconciliation would drop/rename them.
  if (!isRootedType(ref.type ?? '')) return null;
  // 128 bytes comfortably spans `#<id>=<LONGEST_TYPE_NAME>('<22-char id>'`,
  // so the GlobalId is always fully inside the window.
  const end = Math.min(ref.byteOffset + 128, ref.byteOffset + ref.byteLength);
  const head = asSourceBytes(source).decodeUtf8(ref.byteOffset, end);
  const open = head.indexOf('(');
  if (open === -1) return null;
  let i = open + 1;
  while (i < head.length && (head[i] === ' ' || head[i] === '\t' || head[i] === '\n' || head[i] === '\r')) i++;
  if (head[i] !== "'") return null;
  // A GlobalId never contains a quote (charset excludes it), so the next
  // quote closes it.
  const close = head.indexOf("'", i + 1);
  if (close === -1) return null;
  const raw = head.slice(i + 1, close);
  return GLOBAL_ID_RE.test(raw) ? raw : null;
}

/**
 * Replace an entity's GlobalId (first quoted attribute) with `newGuid`.
 * `newGuid` is a 22-char IFC id (no quote in its charset), so this is safe.
 */
export function replaceGlobalId(entityText: string, newGuid: string): string {
  const open = entityText.indexOf('(');
  if (open === -1) return entityText;
  const q1 = entityText.indexOf("'", open + 1);
  if (q1 === -1) return entityText;
  const q2 = entityText.indexOf("'", q1 + 1);
  if (q2 === -1) return entityText;
  return entityText.slice(0, q1 + 1) + newGuid + entityText.slice(q2);
}
