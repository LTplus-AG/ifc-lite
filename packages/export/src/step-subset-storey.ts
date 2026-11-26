// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The storey selector of `selectSubsetSeeds`: resolve a storey token (GUID /
 * name / expressId) to the set of products whose ObjectPlacement chains up
 * through that storey's placement.
 */
import { walkPlacementChain } from '@ifc-lite/data';
import { decodeStepStringLiteral } from '@ifc-lite/encoding';
import { stepString } from './schema-converter-structural-source.js';
import { refsOutsideStrings, SINGLE_REF_RE, splitTopLevelArgs, STRUCTURE_RELATION_ATTRS, STRUCTURE_RELATIONS, SubsetSelectionError } from './step-subset-relations.js';
import type { ParsedStep } from './step-subset.js';

/** Map each IfcLocalPlacement to its parent placement (or null when top-level). */
function placementParents(parsed: ParsedStep): Map<number, number | null> {
  const parents = new Map<number, number | null>();
  for (const inst of parsed.instances.values()) {
    if (inst.type !== 'IFCLOCALPLACEMENT') continue;
    const pm = /^\s*(#\d+|\$)/.exec(inst.body);
    parents.set(inst.id, pm && pm[1].startsWith('#') ? parseInt(pm[1].slice(1), 10) : null);
  }
  return parents;
}

/** Every product whose ObjectPlacement chains up through `storeyPlacementId`. */
export function productsUnderPlacement(storeyPlacementId: number, parsed: ParsedStep): Set<number> {
  const parents = placementParents(parsed);
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
  // Products referencing a selected placement. `refsOutsideStrings`, not a
  // raw REF_RE scan: free text (e.g. `'... see also #40'`) could otherwise
  // seed a product into the wrong storey's extraction.
  const seeds = new Set<number>();
  for (const inst of parsed.instances.values()) {
    for (const ref of refsOutsideStrings(inst.body)) {
      if (under.has(ref)) {
        seeds.add(inst.id);
        break;
      }
    }
  }
  return seeds;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

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
    return UTF8.decode(Uint8Array.from(name, (c) => c.charCodeAt(0)));
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return name; // not valid UTF-8: the bytes were latin1 text after all
  }
}

/** Resolve a --storey selector (GUID / name / expressId) to its placement id. */
export function resolveStoreyPlacement(token: string, parsed: ParsedStep): number {
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
  } else if (/^\d+$/.test(t)) {
    // Storeys are often NAMED '0', '1', ...: a bare number that is not a
    // storey's express id is tried as a name before it is reported.
    const id = parseInt(t, 10);
    const named = byName();
    const isStorey = parsed.instances.get(id)?.type === 'IFCBUILDINGSTOREY';
    if (isStorey && named !== undefined && named !== id) {
      throw new SubsetSelectionError('invalid', `'${t}' is storey #${id} and the Name of storey #${named}; pass #${id} or a GlobalId.`);
    }
    storeyId = isStorey ? id : named ?? id;
  } else if (parsed.guidToId.has(t)) {
    storeyId = parsed.guidToId.get(t);
  } else {
    storeyId = byName();
  }
  if (storeyId === undefined) throw new SubsetSelectionError('not-found', `Storey not found: ${token}`);
  const storey = parsed.instances.get(storeyId);
  if (!storey) throw new SubsetSelectionError('not-found', `Storey not found: ${token} (no #${storeyId})`);
  if (storey.type !== 'IFCBUILDINGSTOREY') {
    throw new SubsetSelectionError('invalid', `#${storeyId} is ${storey.type}, not an IfcBuildingStorey`);
  }
  // IfcBuildingStorey ObjectPlacement is attribute 6 (after Guid, Owner, Name,
  // Description, ObjectType) — the last #ref before LongName/Elevation. Grab the
  // placement ref: the storey references exactly one IfcLocalPlacement.
  // `refsOutsideStrings`, not a raw REF_RE scan: the storey's own Name/
  // Description can contain a `#id`-shaped substring (e.g. `'duplicate of
  // #99'`) naming an unrelated IfcLocalPlacement.
  const refs = refsOutsideStrings(storey.body);
  const placementId = refs.find((r) => parsed.instances.get(r)?.type === 'IFCLOCALPLACEMENT');
  if (placementId === undefined) throw new SubsetSelectionError('invalid', `Storey #${storeyId} has no IfcLocalPlacement`);
  return placementId;
}

/**
 * RelatedElements of every IfcRelContainedInSpatialStructure whose
 * RelatingStructure is in `structures`: a storey's products that are placed
 * in world or building coordinates rather than under the storey's placement.
 * A record that does not split into its six attributes is skipped.
 */
export function containedIn(structures: ReadonlySet<number>, parsed: ParsedStep): number[] {
  const out: number[] = [];
  if (structures.size === 0) return out;
  const [relatingAt, relatedAt] = STRUCTURE_RELATIONS.IFCRELCONTAINEDINSPATIALSTRUCTURE;
  for (const inst of parsed.instances.values()) {
    if (inst.type !== 'IFCRELCONTAINEDINSPATIALSTRUCTURE') continue;
    const args = splitTopLevelArgs(inst.body);
    if (!args || args.length !== STRUCTURE_RELATION_ATTRS) continue;
    const relating = SINGLE_REF_RE.exec(args[relatingAt]);
    if (!relating || !structures.has(Number(relating[1]))) continue;
    for (const id of refsOutsideStrings(args[relatedAt])) if (parsed.instances.has(id)) out.push(id);
  }
  return out;
}
