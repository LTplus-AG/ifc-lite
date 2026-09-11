// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `extract-entities`' `--storey` selector: resolve a storey token (GUID /
 * name / expressId) to the set of products whose ObjectPlacement chains up
 * through that storey's placement. Split out of `extract-entities.ts` to
 * keep that file under its module-size budget.
 */
import { refsOutsideStrings } from './subset-relations.js';
import type { ParsedStep } from './extract-entities.js';

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
  for (const pid of parents.keys()) {
    let cur: number | null = pid;
    let guard = 0;
    while (cur != null && guard++ < 128) {
      if (cur === storeyPlacementId) {
        under.add(pid);
        break;
      }
      cur = parents.get(cur) ?? null;
    }
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

/** Resolve a --storey selector (GUID / name / expressId) to its placement id. */
export function resolveStoreyPlacement(token: string, parsed: ParsedStep): number {
  let storeyId: number | undefined;
  const t = token.trim();
  if (/^#?\d+$/.test(t)) {
    storeyId = parseInt(t.replace('#', ''), 10);
  } else if (parsed.guidToId.has(t)) {
    storeyId = parsed.guidToId.get(t);
  } else {
    // match by name (2nd-to-last-ish quoted arg); scan storeys for a Name match
    for (const inst of parsed.instances.values()) {
      if (inst.type !== 'IFCBUILDINGSTOREY') continue;
      if (inst.body.includes(`'${t}'`)) {
        storeyId = inst.id;
        break;
      }
    }
  }
  if (storeyId === undefined) throw new Error(`Storey not found: ${token}`);
  const storey = parsed.instances.get(storeyId);
  if (!storey || storey.type !== 'IFCBUILDINGSTOREY') {
    throw new Error(`#${storeyId} is ${storey?.type ?? 'missing'}, not an IfcBuildingStorey`);
  }
  // IfcBuildingStorey ObjectPlacement is attribute 6 (after Guid, Owner, Name,
  // Description, ObjectType) — the last #ref before LongName/Elevation. Grab the
  // placement ref: the storey references exactly one IfcLocalPlacement.
  // `refsOutsideStrings`, not a raw REF_RE scan: the storey's own Name/
  // Description can contain a `#id`-shaped substring (e.g. `'duplicate of
  // #99'`) naming an unrelated IfcLocalPlacement.
  const refs = refsOutsideStrings(storey.body);
  const placementId = refs.find((r) => parsed.instances.get(r)?.type === 'IFCLOCALPLACEMENT');
  if (placementId === undefined) throw new Error(`Storey #${storeyId} has no IfcLocalPlacement`);
  return placementId;
}
