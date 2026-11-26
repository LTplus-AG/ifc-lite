// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The storey selector of `selectSubsetSeeds`: resolve a storey token (GUID /
 * name / expressId) to the storey, then to its members (see `storeyMembers`).
 */
import { IfcTypeEnumFromString, isSpatialStructureType, walkPlacementChain } from '@ifc-lite/data';
import { decodeStepStringLiteral } from '@ifc-lite/encoding';
import { expandTypes } from '@ifc-lite/parser';
import { slotRef, stepString } from './schema-converter-structural-source.js';
import { refsOutsideStrings, splitTopLevelArgs, STRUCTURE_RELATION_ATTRS, SubsetSelectionError } from './step-subset-relations.js';
import { structureParents } from './step-subset-spatial-ancestors.js';
import type { ParsedStep } from './step-subset.js';

const OBJECT_PLACEMENT = 5;
const PLACEMENT_TYPES = new Set(['IFCLOCALPLACEMENT', 'IFCGRIDPLACEMENT', 'IFCLINEARPLACEMENT']);

/** Map placements that have a PlacementRelTo slot to their parent placement. */
function placementParents(parsed: ParsedStep, schemaVersion?: string): Map<number, number | null> {
  const parents = new Map<number, number | null>();
  for (const inst of parsed.instances.values()) {
    if (!PLACEMENT_TYPES.has(inst.type)) continue;
    if (inst.type !== 'IFCLOCALPLACEMENT' && !schemaVersion?.toUpperCase().startsWith('IFC4X3')) {
      parents.set(inst.id, null);
      continue;
    }
    // PlacementRelTo is the first attribute; comments around it are trivia.
    parents.set(inst.id, slotRef(splitTopLevelArgs(inst.body)?.[0]));
  }
  return parents;
}

/** Every product whose ObjectPlacement chains up through `storeyPlacementId`. */
export function productsUnderPlacement(storeyPlacementId: number, parsed: ParsedStep, schemaVersion?: string): Set<number> {
  const parents = placementParents(parsed, schemaVersion);
  const productTypes = new Set(expandTypes(['IFCPRODUCT'], schemaVersion));
  const under = new Set<number>();
  // Whether each placement seen so far chains up through the storey's: shared
  // ancestry is walked once, so the pass stays linear in the placement count.
  const chainsUp = new Map<number, boolean>();
  for (const pid of parents.keys()) {
    // The shared walker (#7791): a visited set, no depth cap, so a chain of any
    // length resolves instead of being dropped past an arbitrary guard.
    const walked = walkPlacementChain(pid, (id) => parents.get(id) ?? null, {
      stopAt: (id) => id === storeyPlacementId || chainsUp.has(id),
    });
    const last = walked.ids[walked.ids.length - 1]!;
    const reaches =
      walked.end === 'stopped' && (last === storeyPlacementId || chainsUp.get(last) === true);
    for (const id of walked.ids) if (id !== storeyPlacementId) chainsUp.set(id, reaches);
    if (reaches) under.add(pid);
  }
  const seeds = new Set<number>();
  for (const inst of parsed.instances.values()) {
    if (!productTypes.has(inst.type)) continue;
    const placement = slotRef(splitTopLevelArgs(inst.body)?.[OBJECT_PLACEMENT]);
    if (placement !== null && under.has(placement)) seeds.add(inst.id);
  }
  return seeds;
}

/** IfcBuildingStorey attribute positions: Name, then LongName (after ObjectPlacement, Representation). */
const NAME = 2;
const LONG_NAME = 7;

/** A storey record's decoded string attribute at `index`, or null when it is not a string. */
function storeyText(body: string, index: number): string | null {
  const text = stepString(splitTopLevelArgs(body)?.[index]);
  if (text === null) return null;
  const name = decodeStepStringLiteral(text);
  // The subset parse reads the file as latin1, so a name a tool wrote as raw
  // UTF-8 bytes arrives as one char per byte. Re-read it as UTF-8 when the raw
  // literal itself carries high bytes and no backslash: a directive's decoded
  // Latin-1 text must stay as written, and a name with both raw UTF-8 and a
  // backslash is rare enough to keep as read.
  if (!/[\u0080-\u00ff]/.test(text) || text.includes('\\')) return name;
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    return utf8.decode(Uint8Array.from(name, (c) => c.charCodeAt(0)));
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return name; // not valid UTF-8: the bytes were latin1 text after all
  }
}

/** Resolve a --storey selector (GUID / name / expressId) to the storey and its placement. */
export function resolveStorey(token: string, parsed: ParsedStep): { storeyId: number; placementId: number | undefined } {
  let storeyId: number | undefined;
  const t = token.trim();
  // Exact match on the decoded Name, then on LongName (Revit writes '02' as
  // Name and 'Level 2' as LongName); never on Description or ObjectType text.
  // Two storeys sharing the matched value are refused.
  const byName = (): number | undefined => {
    const storeys = [...parsed.instances.values()].filter((inst) => inst.type === 'IFCBUILDINGSTOREY');
    for (const index of [NAME, LONG_NAME]) {
      const hits = storeys.filter((inst) => storeyText(inst.body, index)?.trim() === t).map((inst) => inst.id);
      if (hits.length > 1) throw new SubsetSelectionError('invalid', `${hits.length} storeys are named '${t}' (#${hits.join(', #')}); pass a GlobalId or #id.`);
      if (hits.length === 1) return hits[0];
    }
    return undefined;
  };
  if (/^#\d+$/.test(t)) {
    storeyId = parseInt(t.slice(1), 10);
  } else if (parsed.guidToId.has(t)) {
    storeyId = parsed.guidToId.get(t);
  } else if (/^\d+$/.test(t)) {
    // Storeys are often NAMED '0', '1', ...: a bare number that is not a
    // storey's express id is tried as a name before it is reported.
    const id = parseInt(t, 10);
    const isStoreyId = parsed.instances.get(id)?.type === 'IFCBUILDINGSTOREY';
    let named: number | undefined;
    try {
      named = byName();
    } catch (err) {
      // For a token that is itself a storey id, report the id/name ambiguity
      // instead of the bare duplicate-name error.
      if (!(err instanceof SubsetSelectionError) || !isStoreyId) throw err;
      throw new SubsetSelectionError('invalid', `'${t}' is storey #${id} and the Name of other storeys; pass #${id} or a GlobalId.`);
    }
    if (isStoreyId && named !== undefined && named !== id) {
      throw new SubsetSelectionError('invalid', `'${t}' is storey #${id} and the Name of storey #${named}; pass #${id} or a GlobalId.`);
    }
    storeyId = isStoreyId ? id : named ?? id;
  } else {
    storeyId = byName();
  }
  if (storeyId === undefined) throw new SubsetSelectionError('not-found', `Storey not found: ${token}`);
  const storey = parsed.instances.get(storeyId);
  if (!storey) throw new SubsetSelectionError('not-found', `Storey not found: ${token} (no #${storeyId})`);
  if (storey.type !== 'IFCBUILDINGSTOREY') {
    throw new SubsetSelectionError('invalid', `#${storeyId} is ${storey.type}, not an IfcBuildingStorey`);
  }
  const placement = slotRef(splitTopLevelArgs(storey.body)?.[OBJECT_PLACEMENT]);
  const placementType = placement === null ? undefined : parsed.instances.get(placement)?.type;
  const placementId = placement !== null && placementType !== undefined && PLACEMENT_TYPES.has(placementType)
    ? placement : undefined;
  // No placement is allowed (IFC permits a storey whose elements are placed
  // independently); membership then comes from containment alone.
  return { storeyId, placementId };
}

const PART_WHOLE_RELATIONS = new Set(['IFCRELAGGREGATES', 'IFCRELNESTS']);
const HOST_RELATIONS = new Set(['IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT', 'IFCRELPROJECTSELEMENT', ...PART_WHOLE_RELATIONS]);

/**
 * Opening -> host element (IfcRelVoidsElement), projection -> host
 * (IfcRelProjectsElement), filler -> opening
 * (IfcRelFillsElement), part -> whole (IfcRelAggregates / IfcRelNests under a
 * non-spatial whole). All five share the six-attribute shape with the relating
 * object at index 4 and the related set at index 5. Relation records that do
 * not split into six attributes are skipped.
 */
function hostOf(parsed: ParsedStep): Map<number, number> {
  const out = new Map<number, number>();
  for (const inst of parsed.instances.values()) {
    if (!HOST_RELATIONS.has(inst.type)) continue;
    const args = splitTopLevelArgs(inst.body);
    if (!args || args.length !== STRUCTURE_RELATION_ATTRS) continue;
    const whole = slotRef(args[4]);
    if (whole === null) continue;
    if (PART_WHOLE_RELATIONS.has(inst.type) && isSpatialStructureType(IfcTypeEnumFromString(parsed.instances.get(whole)?.type ?? ''))) continue;
    for (const part of refsOutsideStrings(args[5])) out.set(part, whole);
  }
  return out;
}

/** The relations that make a spatial element own another; a reference does not. */
const OWNERSHIP = new Set(['IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCRELAGGREGATES']);

/**
 * The nearest storeys above `id` in the spatial tree (containment and spatial
 * aggregation, as `structureParents` reads them). The walk stops at the first
 * storey on each path and keeps a visited set, so a cyclic or deep file
 * terminates.
 */
function owningStoreys(id: number, parents: ReadonlyMap<number, number[]>, parsed: ParsedStep): Set<number> {
  const found = new Set<number>();
  const visited = new Set<number>([id]);
  const stack = [...(parents.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (visited.has(next)) continue;
    visited.add(next);
    if (parsed.instances.get(next)?.type === 'IFCBUILDINGSTOREY') found.add(next);
    else stack.push(...(parents.get(next) ?? []));
  }
  return found;
}

/**
 * A storey's products: every element whose nearest storey in the spatial tree
 * is this one (contained in it, or in a space or zone it aggregates), wherever
 * it is placed; plus, for elements the spatial tree assigns to no storey, those
 * whose placement chains through the storey's. Explicit ownership keeps
 * assigned products separate even when storeys share a placement. A reference
 * (IfcRelReferencedInSpatialStructure) is not ownership. A containment record
 * that cannot be read leaves its element unowned, so the placement decides.
 * Spatial-structure records other than IfcSpace are never products.
 */
export function storeyMembers(
  storeyId: number, placementId: number | undefined, parsed: ParsedStep, schemaVersion?: string,
): number[] {
  const parents = structureParents(parsed.instances, OWNERSHIP);
  const hosts = hostOf(parsed);
  const owners = new Map<number, Set<number>>();
  // An opening, filler or assembly part has no spatial owner of its own; it
  // takes its host's or whole's, so it travels with that element.
  const ownersOf = (id: number): Set<number> => {
    const cached = owners.get(id);
    if (cached) return cached;
    const visited = new Set<number>();
    let at: number | undefined = id;
    let found = new Set<number>();
    while (at !== undefined && !visited.has(at)) {
      visited.add(at);
      found = owningStoreys(at, parents, parsed);
      if (found.size > 0) break;
      at = hosts.get(at);
    }
    owners.set(id, found);
    return found;
  };
  // A storey the selected one aggregates (a mezzanine, a split level) is part of it.
  const within = new Map<number, boolean>();
  const isWithin = (storey: number): boolean => {
    const cached = within.get(storey);
    if (cached !== undefined) return cached;
    const visited = new Set<number>();
    const stack = [storey];
    let found = false;
    while (stack.length > 0 && !found) {
      const next = stack.pop()!;
      if (visited.has(next)) continue;
      visited.add(next);
      if (next === storeyId) found = true;
      else stack.push(...(parents.get(next) ?? []));
    }
    within.set(storey, found);
    return found;
  };
  const ownedHere = (owner: Set<number>): boolean => [...owner].some(isWithin);
  const isCandidate = (id: number): boolean => {
    const type = parsed.instances.get(id)?.type;
    if (type === undefined || PLACEMENT_TYPES.has(type)) return false;
    return type === 'IFCSPACE' || !isSpatialStructureType(IfcTypeEnumFromString(type));
  };
  const out = new Set<number>();
  // Spatial children, and openings/fillers/parts that inherit an owner, wherever placed.
  const consider = (id: number) => {
    if (!out.has(id) && isCandidate(id) && ownedHere(ownersOf(id))) out.add(id);
  };
  for (const id of parents.keys()) consider(id);
  for (const id of hosts.keys()) consider(id);
  const placed = placementId === undefined ? [] : productsUnderPlacement(placementId, parsed, schemaVersion);
  for (const id of placed) {
    if (out.has(id) || !isCandidate(id)) continue;
    const owner = ownersOf(id);
    if (owner.size === 0 || ownedHere(owner)) out.add(id);
  }
  // Unowned parts, openings and fillers of an element the placement pass took
  // come with it, wherever they are placed (fixpoint: parts of parts).
  let grew = true;
  while (grew) {
    grew = false;
    for (const [part, host] of hosts) {
      if (out.has(part) || !out.has(host) || !isCandidate(part) || ownersOf(part).size > 0) continue;
      out.add(part);
      grew = true;
    }
  }
  return [...out];
}
