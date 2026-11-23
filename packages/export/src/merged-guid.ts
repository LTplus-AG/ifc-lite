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
import { stepRecordHead } from './step-record-frame.js';
import { skipStepTrivia } from './step-slot-grammar.js';

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

/** True for IfcRelationship subtypes (objectified relationships), which GlobalId reconciliation never unifies. */
export function isRelationshipType(typeUpper: string): boolean {
  return typeUpper.startsWith('IFCREL');
}

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

function leadingGuidStart(entityText: string): number {
  let open = entityText.indexOf('(');
  if (open >= 0 && entityText.slice(0, open).includes('/*')) open = stepRecordHead(entityText)?.open ?? -1;
  if (open === -1) return -1;
  const quote = skipStepTrivia(entityText, open + 1);
  return entityText[quote] === "'" ? quote + 1 : -1;
}

/** Read the GlobalId actually emitted after remap, re-stamping or conversion. */
export function readLeadingGuid(entityText: string): string | null {
  const start = leadingGuidStart(entityText);
  if (start === -1 || entityText[start + 22] !== "'") return null;
  const raw = entityText.slice(start, start + 22);
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
 * Read an entity's GlobalId (first attribute), usually from its head alone.
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
  const bytes = asSourceBytes(source);
  const recordEnd = ref.byteOffset + ref.byteLength;
  const headEnd = Math.min(ref.byteOffset + 128, recordEnd);
  const guid = readLeadingGuid(bytes.decodeUtf8(ref.byteOffset, headEnd));
  // Leading trivia can put the first slot outside the usual head window.
  return guid ?? (headEnd < recordEnd ? readLeadingGuid(bytes.decodeUtf8(ref.byteOffset, recordEnd)) : null);
}

/** Every rooted entity's GlobalId, by local id in index order: what GlobalId reconciliation works from. */
export function readLocalGuids(
  index: Iterable<[number, ExportEntityRef]>,
  source: Uint8Array | IfcSourceBytes,
): Map<number, string> {
  const guids = new Map<number, string>();
  for (const [id, ref] of index) {
    const guid = extractGlobalIdFast(ref, source);
    if (guid !== null) guids.set(id, guid);
  }
  return guids;
}

/**
 * Replace an entity's GlobalId (first quoted attribute) with `newGuid`.
 * `newGuid` is a 22-char IFC id (no quote in its charset), so this is safe.
 */
export function replaceGlobalId(entityText: string, newGuid: string): string {
  const start = leadingGuidStart(entityText);
  if (start === -1) return entityText;
  const q2 = entityText.indexOf("'", start);
  if (q2 === -1) return entityText;
  return entityText.slice(0, start) + newGuid + entityText.slice(q2);
}
