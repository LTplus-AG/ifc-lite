/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ONE DATUM PER STOREY.
 *
 * `IfcCreator`'s element constructors all take a storey and all emit an
 * `IfcRelContainedInSpatialStructure` into it, so their `IfcLocalPlacement`
 * must chain to that storey's placement. Until 2.0.0 only seven of them did:
 * `addIfcWall`, `addIfcSlab`, `addIfcColumn`, `addIfcBeam`, `addIfcStair`,
 * `addIfcRoof` and `addIfcGableRoof`. The other 21 chained to the world, so on
 * a storey with a non-zero `Elevation` a caller mixing the two families got two
 * datums in one model — measured on a real run as walls sitting at exactly
 * 2x the floor elevation, 1.37 m below the spaces they bounded.
 *
 * These tests refuse to trust the arguments that went in. They parse the
 * emitted STEP and walk `PlacementRelTo` to the world, which is the only form
 * of the check that fails if the builder's placement semantics change again.
 *
 * The storey elevation used here is deliberately negative and irrational-
 * looking: a sign error or a doubling is unmistakable in the failure message,
 * and a datum that is accidentally 0 cannot pass by coincidence.
 */

import { describe, it, expect } from 'vitest';
import { IfcCreator } from './ifc-creator.js';

/** Fitted basement floor plane from the scan the defect was measured on. */
const ELEVATION = -1.368653;

// --------------------------------------------------------------- STEP walk ---

/** Split STEP arguments at depth 0, honouring `''` escapes inside strings. */
function splitStepArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { cur += ch; if (ch === "'") inStr = s[i + 1] === "'"; continue; }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

interface StepEntity { type: string; args: string }

function indexStep(content: string): Map<number, StepEntity> {
  const byId = new Map<number, StepEntity>();
  for (const m of content.matchAll(/#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([^]*?)\);/g)) {
    byId.set(Number(m[1]), { type: m[2], args: m[3] });
  }
  return byId;
}

const refId = (v: string | undefined): number | null =>
  v && v[0] === '#' ? Number(v.slice(1)) : null;

/**
 * World Z of an `IfcLocalPlacement`: the sum of every location Z up the
 * `PlacementRelTo` chain. Throws rather than returning a number it cannot
 * justify — a broken chain must fail the test, not contribute a silent 0.
 */
function worldZOfPlacement(byId: Map<number, StepEntity>, placementRef: string): number {
  let cur = refId(placementRef);
  if (cur === null) throw new Error(`not a placement reference: ${placementRef}`);
  let z = 0;
  const seen = new Set<number>();
  while (cur !== null) {
    if (seen.has(cur)) throw new Error(`cyclic IfcLocalPlacement chain at #${cur}`);
    seen.add(cur);
    const e = byId.get(cur);
    if (!e) throw new Error(`dangling placement reference #${cur}`);
    if (e.type !== 'IFCLOCALPLACEMENT') throw new Error(`#${cur} is ${e.type}, not IFCLOCALPLACEMENT`);
    const [relTo, relPlacement] = splitStepArgs(e.args);
    const axis = byId.get(refId(relPlacement)!);
    if (!axis) throw new Error(`#${cur} has no relative placement`);
    const pt = byId.get(refId(splitStepArgs(axis.args)[0])!);
    if (!pt) throw new Error(`#${cur} placement has no location point`);
    const coords = splitStepArgs(pt.args)[0].replace(/[()]/g, '').split(',').map(Number);
    if (coords.length < 3 || !Number.isFinite(coords[2])) {
      throw new Error(`#${cur} location is not a finite 3D point`);
    }
    z += coords[2];
    cur = relTo === '$' ? null : refId(relTo);
  }
  return z;
}

/** The chain of `IfcLocalPlacement` ids from a product up to the world. */
function placementChain(byId: Map<number, StepEntity>, placementRef: string): number[] {
  const chain: number[] = [];
  let cur = refId(placementRef);
  while (cur !== null) {
    chain.push(cur);
    const e = byId.get(cur);
    if (!e) throw new Error(`dangling placement reference #${cur}`);
    const relTo = splitStepArgs(e.args)[0];
    cur = relTo === '$' ? null : refId(relTo);
  }
  return chain;
}

/**
 * Every placed product in the file, keyed by Name, with its world base Z.
 * `attrIndex` 5 is `ObjectPlacement` on `IfcProduct` and all its subtypes.
 * Spatial elements are excluded — only the products a caller placed.
 */
function productsByName(content: string): Map<string, { type: string; worldZ: number; chain: number[] }> {
  const byId = indexStep(content);
  const skip = new Set(['IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY']);
  const out = new Map<string, { type: string; worldZ: number; chain: number[] }>();
  for (const [, e] of byId) {
    if (!e.type.startsWith('IFC') || skip.has(e.type)) continue;
    const args = splitStepArgs(e.args);
    // A placed product: GlobalId, OwnerHistory, Name, Description, ObjectType,
    // ObjectPlacement (a #ref to an IFCLOCALPLACEMENT), Representation.
    if (args.length < 7 || refId(args[5]) === null) continue;
    if (byId.get(refId(args[5])!)?.type !== 'IFCLOCALPLACEMENT') continue;
    const name = args[2];
    if (!name.startsWith("'")) continue;
    out.set(name.slice(1, -1), {
      type: e.type,
      worldZ: worldZOfPlacement(byId, args[5]),
      chain: placementChain(byId, args[5]),
    });
  }
  return out;
}

// ------------------------------------------------------------ the fixture ---

/**
 * One of every element kind on a single storey, each handed the SAME
 * storey-relative Z. If placement parents are uniform every one of them lands
 * on the same world datum, whatever `Elevation` is.
 *
 * `zRel` is the storey-relative Z fed to every constructor; `expectOffset` is
 * the DESIGNED deviation from the datum for the handful of constructors that
 * deliberately hang their body below the point you give them (documented on
 * each: a footing extends downward from its top centre, a pile from its top).
 */
function buildOneOfEverything(elevation: number, zRel: number) {
  const c = new IfcCreator({ Name: 'placement datum fixture' });
  const s = c.addIfcBuildingStorey({ Name: 'Storey', Elevation: elevation });
  const A = { Start: [0, 0, zRel] as [number, number, number], End: [3, 0, zRel] as [number, number, number] };
  const P = { Position: [0, 0, zRel] as [number, number, number] };

  c.addIfcWall(s, { ...A, Thickness: 0.2, Height: 3, Name: 'wall' });
  c.addIfcSlab(s, { ...P, Thickness: 0.2, Width: 4, Depth: 4, Name: 'slab' });
  c.addIfcColumn(s, { ...P, Width: 0.3, Depth: 0.3, Height: 3, Name: 'column' });
  c.addIfcBeam(s, { ...A, Width: 0.2, Height: 0.4, Name: 'beam' });
  c.addIfcStair(s, { ...P, NumberOfRisers: 6, RiserHeight: 0.18, TreadLength: 0.28, Width: 1.2, Name: 'stair' });
  c.addIfcRoof(s, { ...P, Thickness: 0.2, Width: 4, Depth: 4, Name: 'roof' });
  c.addIfcGableRoof(s, { ...P, Width: 4, Depth: 4, Thickness: 0.2, Slope: Math.PI / 12, Name: 'gableRoof' });
  c.addIfcDoor(s, { ...P, Width: 0.9, Height: 2.1, Name: 'door' });
  c.addIfcWindow(s, { ...P, Width: 1.2, Height: 1.4, Name: 'window' });
  c.addIfcRamp(s, { ...P, Width: 1.5, Length: 4, Thickness: 0.2, Name: 'ramp' });
  c.addIfcRailing(s, { ...A, Height: 1, Name: 'railing' });
  c.addIfcPlate(s, { ...P, Width: 1, Depth: 1, Thickness: 0.01, Name: 'plate' });
  c.addIfcMember(s, { ...A, Width: 0.1, Height: 0.1, Name: 'member' });
  c.addIfcFooting(s, { ...P, Width: 1, Depth: 1, Height: 0.5, Name: 'footing' });
  c.addIfcPile(s, { ...P, Length: 6, Diameter: 0.4, Name: 'pile' });
  c.addIfcSpace(s, { ...P, Width: 4, Depth: 4, Height: 2.6, Name: 'space' });
  c.addIfcCurtainWall(s, { ...A, Height: 3, Name: 'curtainWall' });
  c.addIfcFurnishingElement(s, { ...P, Width: 1, Depth: 0.6, Height: 0.75, Name: 'furnishing' });
  c.addIfcBuildingElementProxy(s, { ...P, Width: 1, Depth: 1, Height: 1, Name: 'proxy' });
  c.addIfcCircularColumn(s, { ...P, Radius: 0.2, Height: 3, Name: 'circularColumn' });
  c.addIfcIShapeBeam(s, {
    ...A, OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.015, Name: 'iShapeBeam',
  });
  c.addIfcLShapeMember(s, { ...A, Depth: 0.1, Width: 0.1, Thickness: 0.01, Name: 'lShapeMember' });
  c.addIfcTShapeMember(s, {
    ...A, FlangeWidth: 0.1, Depth: 0.1, WebThickness: 0.01, FlangeThickness: 0.012, Name: 'tShapeMember',
  });
  c.addIfcUShapeMember(s, {
    ...A, Depth: 0.1, FlangeWidth: 0.05, WebThickness: 0.01, FlangeThickness: 0.012, Name: 'uShapeMember',
  });
  c.addIfcHollowCircularColumn(s, { ...P, Radius: 0.2, WallThickness: 0.01, Height: 3, Name: 'hollowCircularColumn' });
  c.addIfcRectangleHollowBeam(s, { ...A, XDim: 0.2, YDim: 0.1, WallThickness: 0.008, Name: 'rectangleHollowBeam' });
  c.addElement(s, {
    IfcType: 'IFCFLOWSEGMENT',
    Placement: { Location: [0, 0, zRel] },
    Profile: { ProfileType: 'AREA', Radius: 0.05 },
    Depth: 2,
    Name: 'genericElement',
  });
  c.addAxisElement(s, {
    IfcType: 'IFCFLOWSEGMENT',
    ...A,
    Profile: { ProfileType: 'AREA', Radius: 0.05 },
    Name: 'genericAxisElement',
  });

  // Wall-hosted fills: placed against their host wall, so they inherit the
  // storey datum through it rather than naming the storey themselves.
  const host = c.addIfcWall(s, {
    Start: [0, 5, zRel], End: [4, 5, zRel], Thickness: 0.2, Height: 3, Name: 'hostWall',
  });
  c.addIfcWallDoor(host, { Position: [1, 0, 0], Width: 0.9, Height: 2.1, Name: 'wallDoor' });
  c.addIfcWallWindow(host, { Position: [2.5, 0, 1], Width: 1.2, Height: 1.4, Name: 'wallWindow' });

  return { content: c.toIfc().content, storeyId: s };
}

/** Constructors that deliberately place their body below the point given. */
const DESIGNED_OFFSET: Record<string, number> = {
  footing: -0.5,   // Position is the TOP centre; Height extends downward
  pile: -6,        // Position is the TOP; Length extends downward
  wallDoor: 0,     // hosted: [alongWall, 0, baseHeight] with baseHeight 0
  wallWindow: 1,   // hosted: sill 1 m above the wall base
};

// ------------------------------------------------------------------ tests ---

describe('IfcCreator placement datum', () => {
  it('places every element kind on the storey datum, not the world', () => {
    const zRel = 0;
    const { content } = buildOneOfEverything(ELEVATION, zRel);
    const products = productsByName(content);

    // The fixture must actually exercise every constructor, or an omission
    // would make this test pass by testing nothing.
    expect(products.size).toBeGreaterThanOrEqual(30);

    const off: string[] = [];
    for (const [name, p] of products) {
      // Openings are cut in the host's frame and carry their own local offset;
      // the fills that follow them are the interesting hosted case.
      if (p.type === 'IFCOPENINGELEMENT') continue;
      const want = ELEVATION + zRel + (DESIGNED_OFFSET[name] ?? 0);
      if (Math.abs(p.worldZ - want) > 1e-6) {
        off.push(`${name} (${p.type}) at world Z ${p.worldZ}, storey datum puts it at ${want}`);
      }
    }
    expect(off).toEqual([]);
  });

  it('chains every element placement to the storey placement', () => {
    const { content, storeyId } = buildOneOfEverything(ELEVATION, 0);
    const byId = indexStep(content);
    const storeyPlacement = refId(splitStepArgs(byId.get(storeyId)!.args)[5])!;
    expect(byId.get(storeyPlacement)!.type).toBe('IFCLOCALPLACEMENT');

    const orphans: string[] = [];
    for (const [name, p] of productsByName(content)) {
      if (!p.chain.includes(storeyPlacement)) {
        orphans.push(`${name} (${p.type}) chain ${p.chain.join(' -> ')} never passes the storey placement #${storeyPlacement}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it('applies the storey elevation exactly once, to every element kind', () => {
    // A rigid shift of the storey must shift every product by exactly the
    // elevation. A world-parented constructor shifts by 0; one that folded the
    // elevation in twice would shift by 2x. Both are caught here without the
    // test needing to know any constructor's designed offset.
    const flat = productsByName(buildOneOfEverything(0, 0).content);
    const raised = productsByName(buildOneOfEverything(ELEVATION, 0).content);

    expect(raised.size).toBe(flat.size);
    const wrong: string[] = [];
    for (const [name, p] of raised) {
      const base = flat.get(name);
      expect(base, `${name} missing from the flat model`).toBeDefined();
      const shift = p.worldZ - base!.worldZ;
      if (Math.abs(shift - ELEVATION) > 1e-6) {
        wrong.push(`${name} (${p.type}) shifted by ${shift}, not the storey elevation ${ELEVATION}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('passes storey-relative coordinates straight through', () => {
    // The other half of the contract: the Z a caller gives is added to the
    // elevation once, not swallowed and not doubled.
    const zRel = 0.75;
    const products = productsByName(buildOneOfEverything(ELEVATION, zRel).content);
    for (const key of ['wall', 'space', 'slab', 'column', 'proxy', 'genericElement']) {
      const p = products.get(key)!;
      expect(p, `${key} not emitted`).toBeDefined();
      expect(p.worldZ).toBeCloseTo(ELEVATION + zRel, 9);
    }
  });

  it('keeps two storeys on their own datums', () => {
    const c = new IfcCreator({ Name: 'two storeys' });
    const gf = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const ff = c.addIfcBuildingStorey({ Name: 'FF', Elevation: 3.2 });
    c.addIfcSpace(gf, { Position: [0, 0, 0], Width: 4, Depth: 4, Height: 2.6, Name: 'gfSpace' });
    c.addIfcSpace(ff, { Position: [0, 0, 0], Width: 4, Depth: 4, Height: 2.6, Name: 'ffSpace' });
    c.addIfcWall(ff, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 2.6, Name: 'ffWall' });

    const products = productsByName(c.toIfc().content);
    expect(products.get('gfSpace')!.worldZ).toBeCloseTo(0, 9);
    expect(products.get('ffSpace')!.worldZ).toBeCloseTo(3.2, 9);
    expect(products.get('ffWall')!.worldZ).toBeCloseTo(3.2, 9);
  });

  it('rejects an element placed on a storey that does not exist', () => {
    const c = new IfcCreator();
    expect(() => c.addIfcSpace(9999, { Position: [0, 0, 0], Width: 1, Depth: 1, Height: 1 }))
      .toThrow(/Unknown storeyId/);
  });
});
