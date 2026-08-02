#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve ABSOLUTE placement heights out of a STEP file, by walking the
 * IfcLocalPlacement chain to the world.
 *
 * This exists because the placement PARENT is not uniform across
 * `@ifc-lite/create`'s element constructors: `addIfcWall` and `addIfcSlab`
 * place relative to the storey (whose own placement is `[0, 0, Elevation]`),
 * while `addIfcSpace` places relative to the world. A caller that hands the
 * same Z to both puts them 1x elevation apart, and nothing in the pipeline
 * downstream would notice: the exam scores IfcSpace quantities only, and every
 * one of those is invariant under a rigid Z shift of the walls. So the check
 * has to look at the file.
 *
 * Reading it back out of the emitted STEP -- rather than trusting the
 * arguments that were passed in -- is the point: it is the only form of the
 * check that can fail if the builder's placement semantics change underneath.
 */

/** Split STEP arguments at depth 0, honouring `''` escapes inside strings. */
export function splitStepArgs(s) {
  const out = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { cur += ch; if (ch === "'") inStr = (s[i + 1] === "'"); continue; }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** `#id = TYPE(args);` index of a STEP file. */
export function indexStep(content) {
  const byId = new Map();
  for (const m of content.matchAll(/#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([^]*?)\);/g)) {
    byId.set(Number(m[1]), { type: m[2], args: m[3] });
  }
  return byId;
}

const refId = (v) => (v && v[0] === '#' ? Number(v.slice(1)) : null);

/**
 * World Z of an IfcLocalPlacement, by summing the Z of every
 * IfcAxis2Placement3D location up the `PlacementRelTo` chain.
 *
 * Throws rather than returning a number it cannot justify: a malformed or
 * cyclic chain must fail the run, not silently contribute 0 to a height that
 * is then reported as measured.
 */
export function worldZOfPlacement(byId, placementRef) {
  let cur = refId(placementRef);
  if (cur === null) throw new Error(`not a placement reference: ${placementRef}`);
  let z = 0;
  const seen = new Set();
  while (cur !== null) {
    if (seen.has(cur)) throw new Error(`cyclic IfcLocalPlacement chain at #${cur}`);
    seen.add(cur);
    const e = byId.get(cur);
    if (!e) throw new Error(`dangling placement reference #${cur}`);
    if (e.type !== 'IFCLOCALPLACEMENT') throw new Error(`#${cur} is ${e.type}, not IFCLOCALPLACEMENT`);
    const [relTo, relPlacement] = splitStepArgs(e.args);
    const axis = byId.get(refId(relPlacement));
    if (!axis) throw new Error(`#${cur} has no relative placement`);
    const pt = byId.get(refId(splitStepArgs(axis.args)[0]));
    if (!pt) throw new Error(`#${cur} placement has no location point`);
    const coords = splitStepArgs(pt.args)[0].replace(/[()]/g, '').split(',').map(Number);
    if (coords.length < 3 || !Number.isFinite(coords[2])) {
      throw new Error(`#${cur} location is not a finite 3D point: ${splitStepArgs(pt.args)[0]}`);
    }
    z += coords[2];
    cur = relTo === '$' ? null : refId(relTo);
  }
  return z;
}

/**
 * Absolute base Z of every placed product in the file, grouped by IFC type.
 * `attrIndex` 5 is `ObjectPlacement` on IfcProduct and its subtypes.
 */
export function worldBaseZByType(content, types) {
  const byId = indexStep(content);
  const out = new Map();
  for (const [id, e] of byId) {
    if (!types.includes(e.type)) continue;
    const z = worldZOfPlacement(byId, splitStepArgs(e.args)[5]);
    if (!out.has(e.type)) out.set(e.type, []);
    out.get(e.type).push({ expressId: id, worldZ: z });
  }
  return out;
}

/**
 * Fail the run unless the storey's spaces, walls and slab all land on the SAME
 * datum: spaces and walls at the storey elevation, the slab top at it (so the
 * slab body hangs below by its thickness).
 *
 * `tolerance` absorbs the decimal rounding of the STEP serializer, nothing
 * more -- the failure this guards against is a whole elevation, not a
 * millimetre.
 */
export function assertCoherentStoreyDatum(content, { elevationM, slabThicknessM, toleranceM = 1e-6 }) {
  const byType = worldBaseZByType(content, ['IFCSPACE', 'IFCWALL', 'IFCSLAB']);
  const expect = {
    IFCSPACE: elevationM,
    IFCWALL: elevationM,
    IFCSLAB: elevationM - slabThicknessM,
  };
  const bad = [];
  for (const [type, want] of Object.entries(expect)) {
    const got = byType.get(type) ?? [];
    if (got.length === 0) bad.push(`${type}: none emitted`);
    for (const g of got) {
      if (Math.abs(g.worldZ - want) > toleranceM) {
        bad.push(`${type} #${g.expressId} base world Z ${g.worldZ} but the storey datum puts it at ${want} (off by ${g.worldZ - want} m)`);
      }
    }
  }
  if (bad.length) {
    throw new Error(`incoherent storey datum in the generated model:\n  ${bad.slice(0, 6).join('\n  ')}`);
  }
  return Object.fromEntries([...byType].map(([t, v]) => [t, v[0].worldZ]));
}
