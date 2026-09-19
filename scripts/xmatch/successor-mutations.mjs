/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The #4955 mutation roles of the xmatch generator — `deletedNearby` (the
 * successor negative control), `respecified`, `thickened`, `swapped`,
 * `splitLength` — and the donor-map lookup `swapped` relies on. Split out of
 * `mutate.mjs` for size; that module still owns role assignment, the answer
 * key and the re-GUID/permutation. Behaviour is byte-identical to before the
 * split (the scorecard is the proof).
 */

import { cloneElement, deleteElement, renameElement } from './edits.mjs';
import { ownedRectangleExtrusion, shrinkOwnedExtrusion, splitElementLength, thickenElement } from './rectangle-edits.mjs';
import {
  ownedMappedItem,
  ownedPropertyValues,
  representationMapDigest,
  representationMapsOf,
  respecifyProperty,
  swapMappedItem,
} from './successor-edits.mjs';
import { classFamilyResolver } from '../../packages/diff/dist/class-families.js';

/** Mirrors the engine's unexported `POSITION_EXTENT_RATIO`. */
const POSITION_EXTENT_RATIO = 2;

/** Stable key for excluding one recipient/map pairing on a regeneration. */
export function donorPairKey(productId, mapId) {
  return `${productId}:${mapId}`;
}

/** Per-axis extents within the same ratio the `position` successor stage accepts. */
export function sizesComparable(a, b) {
  if (!a || !b) return false;
  for (let axis = 0; axis < 3; axis++) {
    const ea = a.max?.[axis] - a.min?.[axis];
    const eb = b.max?.[axis] - b.min?.[axis];
    if (!Number.isFinite(ea) || !Number.isFinite(eb)) return false;
    const big = Math.max(ea, eb);
    const small = Math.min(ea, eb);
    // Two flat extents agree; one flat against one not does not.
    if (big <= 0) continue;
    if (small <= 0 || big / small > POSITION_EXTENT_RATIO) return false;
  }
  return true;
}

/**
 * Swaps that the canonical geometry pass proves cannot enter the engine's
 * `position` successor stage. This is the definitive check after mutation:
 * it sees profile dimensions, mapped-item transforms and product placements,
 * rather than trying to infer geometry from STEP point records.
 */
export function incomparableSwaps(key, baseFingerprints, headFingerprints) {
  const baseById = new Map(baseFingerprints.map((fingerprint) => [fingerprint.ref, fingerprint]));
  const headById = new Map(headFingerprints.map((fingerprint) => [fingerprint.ref, fingerprint]));
  const failures = [];
  for (const element of key.elements) {
    if (element.kind !== 'swapped') continue;
    const donorMap = element.detail?.donorMap;
    const headId = element.head.length === 1 ? element.head[0] : undefined;
    const base = baseById.get(element.base);
    const head = headId === undefined ? undefined : headById.get(headId);
    if (!Number.isInteger(donorMap) || !sizesComparable(base?.aabb, head?.aabb)) {
      failures.push({ base: element.base, donorMap, head: headId });
    }
  }
  return failures;
}

/**
 * Apply one #4955 role to element `id`, recording the answer-key entry and the
 * applied count on the context `mutateModel` shares. Returns `false` when
 * `role` is not one of this module's roles, so the caller's chain continues.
 *
 * @param {{ file: object, index: object, plan: object, freshName: (kind: string) => string,
 *   donors: Map<number, number>, entries: object[], applied: Record<string, number>,
 *   insertedNearbyHeadIds: number[] }} ctx
 */
export function applySuccessorRole(ctx, role, id, geometryClass) {
  const { file, index, plan, freshName, donors, entries, applied, insertedNearbyHeadIds } = ctx;
  if (role === 'deletedNearby') {
    // NEGATIVE CONTROL for the successor stage. The element is deleted like
    // any other, and a head-only element of the SAME class, under a new
    // name, is planted inside its box at 0.3x its size on every axis. It
    // is a clone so it is enrolled in the same containment, type and
    // property lists — a genuinely new small thing in the same storey — and
    // its shape is shrunk on the chain the deleted element owned outright.
    // Nothing may claim it as the deleted element's successor.
    const owned = ownedRectangleExtrusion(index, id);
    const copy = cloneElement(file, index, id, { name: freshName('nearby') });
    deleteElement(file, index, id);
    shrinkOwnedExtrusion(file, index, owned, plan.nearbyFactor);
    insertedNearbyHeadIds.push(copy);
    entries.push({
      base: id,
      kind: 'deleted',
      class: geometryClass,
      head: [],
      detail: { insertedNearby: copy, factor: plan.nearbyFactor },
    });
    applied.deleted++;
    applied.insertedNearby++;
  } else if (role === 'respecified') {
    // One data edit, no geometry edit. A property value the element owns
    // outright where it has one, the element's own Name otherwise; both
    // move the data hash and neither touches the property-name multiset the
    // guards assert identical.
    const owned = ownedPropertyValues(index, id);
    const property = owned.find((row) => respecifyProperty(index, row.propertyId));
    if (!property) renameElement(index, id, freshName('respecified'));
    entries.push({
      base: id,
      kind: 'respecified',
      class: geometryClass,
      head: [id],
      detail: property ? { edit: 'property', property: property.name } : { edit: 'name' },
    });
    applied.respecified++;
  } else if (role === 'thickened') {
    const ok = thickenElement(file, index, id, plan.thickenScale);
    if (ok) renameElement(index, id, freshName('thickened'));
    entries.push({
      base: id,
      kind: ok ? 'thickened' : 'renamed',
      class: geometryClass,
      head: [id],
      detail: ok ? { stratum: 'footprint', scale: plan.thickenScale } : undefined,
    });
    applied[ok ? 'thickened' : 'renamed']++;
  } else if (role === 'swapped') {
    const donor = donors.get(id);
    const ok = swapMappedItem(index, id, donor);
    if (ok) renameElement(index, id, freshName('swapped'));
    entries.push({
      base: id,
      kind: ok ? 'swapped' : 'renamed',
      class: geometryClass,
      head: [id],
      detail: ok ? { stratum: 'position', donorMap: donor } : undefined,
    });
    applied[ok ? 'swapped' : 'renamed']++;
  } else if (role === 'splitLength') {
    const copy = splitElementLength(file, index, id, [freshName('split'), freshName('split')]);
    const ok = copy !== undefined;
    entries.push({
      base: id,
      kind: ok ? 'splitLength' : 'renamed',
      class: geometryClass,
      head: ok ? [id, copy] : [id],
      detail: ok ? { pieces: 2 } : undefined,
    });
    applied[ok ? 'splitLength' : 'renamed']++;
  } else {
    return false;
  }
  return true;
}

/**
 * For every element whose body is one owned `IfcMappedItem`, the donor
 * `IfcRepresentationMap` `swapped` will point it at: a map some OTHER element
 * of the same `ifcType` uses (a door swapped for a different door type), or
 * failing that of the same class family — the bucket the successor stage
 * searches — and whose geometry is structurally DIFFERENT from the element's
 * own (`representationMapDigest`): a copy of the same shape under another map
 * id would leave the world geometry hash unchanged, and the engine would
 * rightly pair that as `respecified`. It must also have a user whose canonical
 * geometry bounds are comparable to the recipient: the `position` successor
 * profile rejects a per-axis size ratio over 2, so a donor beyond that
 * threshold is not a valid positive. Missing geometry fails closed.
 * Elements with no such donor are absent from the map and are not eligible.
 * Donors are chosen by position in a sorted list, not by the PRNG, so this
 * draws nothing from the stream the re-GUID and permutation use.
 */
export function mapDonors(index, population, geometryAabbs = new Map(), excludedDonors = new Set()) {
  const familyOf = classFamilyResolver();
  const digests = new Map();
  const digestOf = (mapId) => {
    let digest = digests.get(mapId);
    if (digest === undefined) {
      digest = representationMapDigest(index, mapId);
      digests.set(mapId, digest);
    }
    return digest;
  };
  const usersByMap = new Map();
  const usersByType = new Map();
  const usersByFamily = new Map();
  for (const id of population) {
    const statement = index.byId.get(id);
    for (const mapId of representationMapsOf(index, id)) {
      for (const [table, key] of [
        [usersByType, statement.type],
        [usersByFamily, familyOf(statement.type)],
      ]) {
        const set = table.get(key) ?? new Set();
        set.add(mapId);
        table.set(key, set);
      }
    }
    // A product with several mapped items has bounds for their union, not for
    // any one donor map. Only a single owned mapped item is sound evidence.
    const owned = ownedMappedItem(index, id);
    if (owned) {
      const users = usersByMap.get(owned.mapId) ?? new Set();
      users.add(id);
      usersByMap.set(owned.mapId, users);
    }
  }
  const donors = new Map();
  let ordinal = 0;
  for (const id of population) {
    const owned = ownedMappedItem(index, id);
    if (!owned) continue;
    const statement = index.byId.get(id);
    const own = digestOf(owned.mapId);
    const ownAabb = geometryAabbs.get(id);
    if (!ownAabb) continue;
    const candidates = (pool) =>
      [...(pool ?? [])]
        .filter(
          (mapId) =>
            mapId !== owned.mapId &&
            digestOf(mapId) !== own &&
            !excludedDonors.has(donorPairKey(id, mapId)) &&
            [...(usersByMap.get(mapId) ?? [])].some((userId) =>
              sizesComparable(ownAabb, geometryAabbs.get(userId)),
            ),
        )
        .sort((a, b) => a - b);
    let choices = candidates(usersByType.get(statement.type));
    if (choices.length === 0) choices = candidates(usersByFamily.get(familyOf(statement.type)));
    if (choices.length === 0) continue;
    donors.set(id, choices[ordinal++ % choices.length]);
  }
  return donors;
}

/**
 * Assign every eligible member of the first `count` same-content groups to the
 * `movedGroup` role, returning each member's ordinal within its group.
 */
