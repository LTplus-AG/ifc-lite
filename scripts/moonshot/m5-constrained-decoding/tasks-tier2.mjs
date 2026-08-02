/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tier-2 task set for the M5 exam (B2.3 follow-up), restructured after the
 * hostile G2 review of tier-1. Design responses, in order:
 *
 * 1. RUBRIC HEADROOM: criteria are no longer transcriptions of brief
 *    numbers alone. Added: 'tight' value criteria (1 percent full-credit
 *    band instead of 5), per-element identity checks (windowAreas),
 *    placement-intent checks measured from mesh boxes (opening-overlap
 *    freedom, column grid regularity, per-storey window distribution), and
 *    an intent-fidelity factor over the emitted ops (below). A truncated
 *    -spec headroom probe (TRUNCATED_SPEC) must land mid-scale before the
 *    arm comparison is trusted; see run-tier2.mjs --headroom.
 *
 * 2. HELD-OUT RULES: DSL_SPEC_TIER2 gives every arm the op syntax, field
 *    semantics, coordinate conventions, numeric limits and one example,
 *    but WITHHOLDS the validator's semantic rules listed in
 *    HELD_OUT_RULES. The kernel-feedback arm can learn them only through
 *    rejection messages; one-shot arms cannot. All arms are told
 *    undocumented rules exist (fair notice), and all arms get the same
 *    infeasibility protocol.
 *
 * 5. INFEASIBLE BRIEFS: three tasks marked `infeasible: true`. Correct
 *    behavior is declaring infeasibility ({"infeasible": true, ...}),
 *    scored 1; silently mutating a stated value until the kernel accepts
 *    (constraint laundering) or emitting any program scores 0. Feasible
 *    tasks carry a `stated` spec; quality is multiplied by the fraction of
 *    emitted ops that honor explicitly stated values (intent fidelity).
 *
 * Families: packing traps where naive even spacing overlaps (T2-01, T2-09,
 * T2-11, T2-18), computed glazing ratios (T2-02, T2-12), boundary vertical
 * fit (T2-03), area budgets (T2-04, T2-13), graded towers with per-storey
 * differences (T2-05, T2-14, T2-19), column grids at scale (T2-06, T2-15),
 * facade+door coupling (T2-07, T2-16), properties at scale (T2-08, T2-17),
 * capstones (T2-10, T2-20). Golden programs prove satisfiability of all 20
 * feasible briefs at quality 1.0 before any model call (selftest).
 */

/** Validator rules deliberately withheld from every tier-2 prompt. */
export const HELD_OUT_RULES = [
  'opening horizontal fit: along - width/2 >= 0.05 and along + width/2 <= wallLength - 0.05',
  'opening vertical fit: sill >= 0 and sill + height <= wallHeight - 0.05 (head clearance)',
  'openings on one wall must not overlap',
  'wall axis: start z must equal end z, and axis length >= 0.3 m',
  'storeys must have pairwise distinct elevations',
];

/**
 * Tier-2 prompt spec: syntax, conventions, limits and example - but NOT the
 * held-out semantic rules above. Both one-shot arms and the constrained arm
 * see exactly this text; the only extra information the constrained arm
 * ever receives is kernel/validator rejection messages.
 */
export const DSL_SPEC_TIER2 = `IFC-OPS DSL. A program is a JSON array of op objects. Units metres; X east, Y north, Z up.
Element coordinates are STOREY-LOCAL: z=0 is the storey's elevation. Ids: lowercase [a-z][a-z0-9_-]*, unique across the program.

Ops (all fields required, no extra fields allowed):
1 {"op":"create_storey","id":ID,"name":S,"elevation":N}
   One per floor. A storey must be created before elements reference it.
2 {"op":"create_slab","id":ID,"storey":SID,"position":[x,y,z],"width":W,"depth":D,"thickness":T}
   position = MIN corner; slab occupies [x,x+W] x [y,y+D] x [z,z+T].
3 {"op":"create_wall","id":ID,"storey":SID,"start":[x,y,z],"end":[x,y,z],"thickness":T,"height":H}
   Straight wall along axis start->end, extrudes up by H from z.
4 {"op":"add_window","id":ID,"wall":WID,"along":A,"sill":S,"width":W,"height":H}
   Window centred A metres from the wall's start along its axis, base at sill height S above the wall bottom.
5 {"op":"add_door","id":ID,"wall":WID,"along":A,"width":W,"height":H}
   Like add_window but the base is the wall bottom (sill 0).
6 {"op":"create_column","id":ID,"storey":SID,"position":[x,y,z],"width":W,"depth":D,"height":H}
   position = centre of the rectangular section at the base.
7 {"op":"create_beam","id":ID,"storey":SID,"start":[x,y,z],"end":[x,y,z],"width":W,"height":H}
   Axis start->end at the section centre.
8 {"op":"create_space","id":ID,"storey":SID,"name":S,"position":[x,y,z],"width":W,"depth":D,"height":H}
   Room volume; position = MIN corner (like create_slab).
9 {"op":"set_property","target":EID,"pset":S,"name":S,"value":S|N|BOOL}
   Attach a property to an earlier element (not a storey).

Numeric limits: |coordinates| <= 1000; thickness <= 2; heights <= 20; other dims <= 100; max 80 ops.
Typical composition: slab position [0,0,0] with walls on its top face (start/end z = slab thickness) placed along the slab edges (wall axis is the wall centreline).
The validating kernel additionally enforces geometric sanity rules that are NOT documented here; ops violating them are rejected.
If the brief cannot be satisfied exactly as stated (a stated dimension or position cannot be realized), output ONLY the object {"infeasible": true, "reason": "..."} instead of a program. NEVER silently change a value the brief states explicitly.

Example, one storey with a slab, one wall with a window:
[{"op":"create_storey","id":"s1","name":"Ground","elevation":0},
 {"op":"create_slab","id":"slab1","storey":"s1","position":[0,0,0],"width":8,"depth":6,"thickness":0.2},
 {"op":"create_wall","id":"w1","storey":"s1","start":[0,0.1,0.2],"end":[8,0.1,0.2],"thickness":0.2,"height":3},
 {"op":"add_window","id":"win1","wall":"w1","along":4,"sill":0.9,"width":1.2,"height":1.4}]`;

/**
 * Deliberately mediocre spec for the rubric-headroom probe: op names and
 * field lists only - no coordinate conventions, no composition guidance,
 * no example, no limits. If the rubric still scores this proposer ~1.0,
 * the rubric has no headroom and the arm comparison would be meaningless.
 */
export const TRUNCATED_SPEC = `IFC-OPS DSL. Output a JSON array of op objects. Ops and their fields:
{"op":"create_storey","id":..,"name":..,"elevation":..}
{"op":"create_slab","id":..,"storey":..,"position":..,"width":..,"depth":..,"thickness":..}
{"op":"create_wall","id":..,"storey":..,"start":..,"end":..,"thickness":..,"height":..}
{"op":"add_window","id":..,"wall":..,"along":..,"sill":..,"width":..,"height":..}
{"op":"add_door","id":..,"wall":..,"along":..,"width":..,"height":..}
{"op":"create_column","id":..,"storey":..,"position":..,"width":..,"depth":..,"height":..}
{"op":"create_beam","id":..,"storey":..,"start":..,"end":..,"width":..,"height":..}
{"op":"create_space","id":..,"storey":..,"name":..,"position":..,"width":..,"depth":..,"height":..}
{"op":"set_property","target":..,"pset":..,"name":..,"value":..}
position/start/end are [x,y,z] arrays; storey/wall/target reference earlier ids.`;

function count(name, key, target) {
  return { name, type: 'count', key, target };
}

function value(name, get, target) {
  return { name, type: 'value', get, target };
}

function tight(name, get, target) {
  return { name, type: 'tight', get, target };
}

/** Fraction of openings (windows + doors) not intersecting any other. */
function overlapFree() {
  return {
    name: 'openings do not overlap', type: 'property',
    eval: (m) => {
      const boxes = [...(m.boxes?.windows ?? []), ...(m.boxes?.doors ?? [])];
      if (boxes.length === 0) return 1;
      const eps = 1e-3;
      const bad = new Set();
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          const hit = [0, 1, 2].every(
            (k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) > eps,
          );
          if (hit) { bad.add(i); bad.add(j); }
        }
      }
      return 1 - bad.size / boxes.length;
    },
  };
}

/**
 * Fraction of openings (windows + doors) contained inside some wall box -
 * the "wall-membership" intent measure the tier-1 review asked for. Caught
 * live in the headroom probe: a truncated-spec proposer hung a window 0.5 m
 * past the wall end and every AABB-derived area criterion still scored 1.0.
 * Tolerances: tight (0.02 m) along the wall axis and vertically, loose
 * (0.45 m) across the thickness axis (window solids may protrude through
 * the wall faces by construction).
 */
function openingsContained() {
  return {
    name: 'openings contained in a wall', type: 'property',
    eval: (m) => {
      const openings = [...(m.boxes?.windows ?? []), ...(m.boxes?.doors ?? [])];
      const walls = m.boxes?.walls ?? [];
      if (openings.length === 0) return 1;
      if (walls.length === 0) return 0;
      const tolL = 0.02;
      const tolT = 0.45;
      let ok = 0;
      for (const o of openings) {
        const inside = walls.some((w) => {
          const wdx = w.max[0] - w.min[0];
          const wdy = w.max[1] - w.min[1];
          const tx = wdx <= wdy ? tolT : tolL;
          const ty = wdx <= wdy ? tolL : tolT;
          return o.min[0] >= w.min[0] - tx && o.max[0] <= w.max[0] + tx
            && o.min[1] >= w.min[1] - ty && o.max[1] <= w.max[1] + ty
            && o.min[2] >= w.min[2] - 0.02 && o.max[2] <= w.max[2] + 0.02;
        });
        if (inside) ok += 1;
      }
      return ok / openings.length;
    },
  };
}

/** Fraction of `kind` elements whose plan centre sits on the stated grid. */
function gridMatch(name, kind, xs, ys, tol = 0.15) {
  return {
    name, type: 'property',
    eval: (m) => {
      const els = m.boxes?.[kind] ?? [];
      if (els.length === 0) return 0;
      let hits = 0;
      for (const b of els) {
        const okx = xs.some((x) => Math.abs(b.center[0] - x) <= tol);
        const oky = ys.some((y) => Math.abs(b.center[1] - y) <= tol);
        if (okx && oky) hits += 1;
      }
      return hits / els.length;
    },
  };
}

/** Fraction of elevation bands holding exactly the expected window count. */
function windowsPerBand(name, bands) {
  return {
    name, type: 'property',
    eval: (m) => {
      const wins = m.boxes?.windows ?? [];
      let ok = 0;
      for (const [lo, hi, expected] of bands) {
        const n = wins.filter((b) => b.center[2] >= lo && b.center[2] < hi).length;
        if (n === expected) ok += 1;
      }
      return ok / bands.length;
    },
  };
}

export const TASKS_TIER2 = [
  {
    id: 'T2-01', difficulty: 'tier2-trap', name: 'packed facade 6m',
    brief: 'One storey at elevation 0 with a single straight wall, 6 m long, 0.3 m thick, 3 m high, carrying exactly four windows, each 1.4 m wide and 1.2 m high with a 0.9 m sill. The windows must not overlap - they occupy 5.6 m of the 6 m wall, so choose the along positions carefully.',
    stated: [
      { op: 'add_window', field: 'width', value: 1.4 },
      { op: 'add_window', field: 'height', value: 1.2 },
      { op: 'add_window', field: 'sill', value: 0.9 },
      { op: 'create_wall', field: 'height', value: 3 },
      { op: 'create_wall', field: 'thickness', value: 0.3 },
    ],
    criteria: [
      count('storeys = 1', 'storeys', 1),
      count('walls = 1', 'walls', 1),
      count('windows = 4', 'windows', 4),
      tight('total glazed area 6.72 m2', (m) => m.windowArea, 6.72),
      tight('gross wall area 18 m2', (m) => m.wallGrossArea, 18),
      overlapFree(),
      openingsContained(),
    ],
  },
  {
    id: 'T2-02', difficulty: 'tier2-arith', name: 'computed ratio 30',
    brief: 'One storey at elevation 0 with a single south facade wall, 9 m long, 0.3 m thick, 3 m high. Add exactly three identical non-overlapping windows, sized and placed by you so that the total glazed area is exactly 30 percent of the 27 m2 facade. You choose the window width, height and sill; all three windows must be the same size.',
    stated: [
      { op: 'create_wall', field: 'height', value: 3 },
      { op: 'create_wall', field: 'thickness', value: 0.3 },
    ],
    criteria: [
      count('walls = 1', 'walls', 1),
      count('windows = 3', 'windows', 3),
      tight('total glazed area 8.1 m2', (m) => m.windowArea, 8.1),
      tight('glazing ratio 0.30', (m) => (m.wallGrossArea > 0 ? m.windowArea / m.wallGrossArea : null), 0.3),
      tight('smallest window 2.7 m2', (m) => m.windowAreas[0], 2.7),
      tight('largest window 2.7 m2', (m) => m.windowAreas.at(-1), 2.7),
      overlapFree(),
      openingsContained(),
    ],
  },
  {
    id: 'T2-03', difficulty: 'tier2-trap', name: 'boundary sill',
    brief: 'One storey at elevation 0: a 10 m by 6 m slab, 0.2 m thick, min corner at the origin, and one wall along the south edge of the slab, 10 m long, 0.3 m thick and only 2.6 m high, standing on the slab. Put exactly three non-overlapping windows in it, each 1.2 m wide and 1.4 m high, with the sill at exactly 1.15 m.',
    stated: [
      { op: 'add_window', field: 'width', value: 1.2 },
      { op: 'add_window', field: 'height', value: 1.4 },
      { op: 'add_window', field: 'sill', value: 1.15 },
      { op: 'create_wall', field: 'height', value: 2.6 },
    ],
    criteria: [
      count('slabs = 1', 'slabs', 1),
      count('walls = 1', 'walls', 1),
      count('windows = 3', 'windows', 3),
      tight('total glazed area 5.04 m2', (m) => m.windowArea, 5.04),
      value('overall height 2.8 m', (m) => m.overall?.dz, 2.8),
      overlapFree(),
      openingsContained(),
    ],
  },
  {
    id: 'T2-04', difficulty: 'tier2-arith', name: 'area budget 200',
    brief: 'A single-storey office at elevation 0: a 20 m by 12 m slab, 0.25 m thick, min corner at the origin, and exactly four spaces standing on the slab, all 2.8 m high: a corridor 2.5 m wide running the full 12 m depth (30 m2), one meeting room of 50 m2, and two offices of 60 m2 each, so the room areas sum to exactly 200 m2. Every space must lie fully inside the 20 by 12 footprint.',
    stated: [
      { op: 'create_space', field: 'height', value: 2.8 },
      { op: 'create_slab', field: 'thickness', value: 0.25 },
    ],
    criteria: [
      count('slabs = 1', 'slabs', 1),
      count('spaces = 4', 'spaces', 4),
      value('slab X extent 20 m', (m) => m.footprint?.dx, 20),
      tight('total room area 200 m2', (m) => m.spaceArea, 200),
      tight('smallest room 30 m2', (m) => m.spaceAreas[0], 30),
      tight('largest room 60 m2', (m) => m.spaceAreas.at(-1), 60),
    ],
  },
  {
    id: 'T2-05', difficulty: 'tier2-scale', name: 'graded tower 4',
    brief: 'Four storeys at elevations 0, 3, 6 and 9, named Level 1 to Level 4. Every storey has a 12 m by 8 m slab, 0.2 m thick, min corner at the origin, and one facade wall 12 m long along the south edge of its slab, 0.25 m thick, 2.7 m high, standing on the slab. All windows are 1.0 m wide by 1.0 m high with a 1.0 m sill. The window count grows by storey: Level 1 gets 2 windows, Level 2 gets 3, Level 3 gets 4 and Level 4 gets 5 - fourteen in total, none overlapping.',
    stated: [
      { op: 'add_window', field: 'width', value: 1.0 },
      { op: 'add_window', field: 'height', value: 1.0 },
      { op: 'add_window', field: 'sill', value: 1.0 },
      { op: 'create_wall', field: 'height', value: 2.7 },
    ],
    criteria: [
      count('storeys = 4', 'storeys', 4),
      count('slabs = 4', 'slabs', 4),
      count('walls = 4', 'walls', 4),
      count('windows = 14', 'windows', 14),
      tight('total glazed area 14 m2', (m) => m.windowArea, 14),
      windowsPerBand('windows per level 2/3/4/5', [[0, 3, 2], [3, 6, 3], [6, 9, 4], [9, 12, 5]]),
      openingsContained(),
    ],
  },
  {
    id: 'T2-06', difficulty: 'tier2-scale', name: 'big frame 36',
    brief: 'A three-storey concrete frame with storeys at elevations 0, 3.2 and 6.4. Each storey has: a 16 m by 12 m slab, 0.2 m thick, min corner at the origin; twelve columns (0.35 m by 0.35 m section, 3 m high) standing on the slab in a 4 by 3 grid at x in {2, 6, 10, 14} and y in {2, 6, 10}; and four beams (0.3 m wide, 0.5 m deep) at the column heads, one per column line x in {2, 6, 10, 14}, each spanning in Y from y = 2 to y = 10.',
    stated: [
      { op: 'create_column', field: 'width', value: 0.35 },
      { op: 'create_column', field: 'depth', value: 0.35 },
      { op: 'create_column', field: 'height', value: 3 },
      { op: 'create_beam', field: 'width', value: 0.3 },
    ],
    criteria: [
      count('storeys = 3', 'storeys', 3),
      count('slabs = 3', 'slabs', 3),
      count('columns = 36', 'columns', 36),
      count('beams = 12', 'beams', 12),
      value('slab X extent 16 m', (m) => m.footprint?.dx, 16),
      value('slab Y extent 12 m', (m) => m.footprint?.dy, 12),
      gridMatch('columns on 4x3 grid', 'columns', [2, 6, 10, 14], [2, 6, 10]),
    ],
  },
  {
    id: 'T2-07', difficulty: 'tier2-arith', name: 'facade with door 14',
    brief: 'A single-storey house at elevation 0: a 14 m by 10 m slab, 0.25 m thick, min corner at the origin, and four perimeter walls, 0.3 m thick, 3 m high, on top of the slab. The south wall (the 14 m wall along y = 0) must reach exactly 25 percent glazing of its 42 m2 face using five identical windows of 2.1 m2 each (1.4 m wide by 1.5 m high, sill 0.9 m), and additionally carries one entrance door 1.0 m wide by 2.1 m high. Nothing on that wall may overlap.',
    stated: [
      { op: 'add_window', field: 'width', value: 1.4 },
      { op: 'add_window', field: 'height', value: 1.5 },
      { op: 'add_window', field: 'sill', value: 0.9 },
      { op: 'add_door', field: 'width', value: 1.0 },
      { op: 'add_door', field: 'height', value: 2.1 },
    ],
    criteria: [
      count('walls = 4', 'walls', 4),
      count('windows = 5', 'windows', 5),
      count('doors = 1', 'doors', 1),
      value('slab X extent 14 m', (m) => m.footprint?.dx, 14),
      value('slab Y extent 10 m', (m) => m.footprint?.dy, 10),
      tight('total glazed area 10.5 m2', (m) => m.windowArea, 10.5),
      overlapFree(),
      openingsContained(),
    ],
  },
  {
    id: 'T2-08', difficulty: 'tier2-scale', name: 'properties at scale',
    brief: 'Two storeys at elevations 0 and 3.5. Each storey: a 15 m by 9 m slab, 0.2 m thick, min corner at the origin, and four perimeter walls, 0.25 m thick, 3.3 m high, on the slab. Add six columns (0.4 m by 0.4 m, 3.3 m high) on the ground-floor slab at x in {3, 7.5, 12} and y in {3, 6}. Then set the property FireRating = "REI90" in property set "Pset_WallCommon" on EVERY wall, and the property LoadBearing = true in property set "Pset_ColumnCommon" on EVERY column.',
    stated: [
      { op: 'create_column', field: 'width', value: 0.4 },
      { op: 'create_column', field: 'height', value: 3.3 },
      { op: 'create_wall', field: 'height', value: 3.3 },
    ],
    criteria: [
      count('storeys = 2', 'storeys', 2),
      count('slabs = 2', 'slabs', 2),
      count('walls = 8', 'walls', 8),
      count('columns = 6', 'columns', 6),
      gridMatch('columns on 3x2 grid', 'columns', [3, 7.5, 12], [3, 6]),
      {
        name: 'FireRating REI90 on all walls', type: 'property',
        eval: (m) => m.propertyFraction('IFCWALL', 'Pset_WallCommon', 'FireRating', 'REI90'),
      },
      {
        name: 'LoadBearing true on all columns', type: 'property',
        eval: (m) => m.propertyFraction('IFCCOLUMN', 'Pset_ColumnCommon', 'LoadBearing', true),
      },
    ],
  },
  {
    id: 'T2-09', difficulty: 'tier2-trap', name: 'tight corridor doors',
    brief: 'One storey at elevation 0 with two parallel corridor walls, each 3.0 m long, 0.2 m thick and 2.5 m high, one along y = 0 and one along y = 2, both starting at x = 0. EACH wall carries two doors, each 1.2 m wide and 2.1 m high, that must not overlap - each wall is only 3.0 m long and the two doors occupy 2.4 m of it, so choose the along positions carefully.',
    stated: [
      { op: 'add_door', field: 'width', value: 1.2 },
      { op: 'add_door', field: 'height', value: 2.1 },
      { op: 'create_wall', field: 'height', value: 2.5 },
    ],
    criteria: [
      count('walls = 2', 'walls', 2),
      count('doors = 4', 'doors', 4),
      tight('gross wall area 15 m2', (m) => m.wallGrossArea, 15),
      value('overall height 2.5 m', (m) => m.overall?.dz, 2.5),
      overlapFree(),
      openingsContained(),
    ],
  },
  {
    id: 'T2-10', difficulty: 'tier2-capstone', name: 'studio building',
    brief: 'A two-storey studio building with storeys at elevations 0 and 3.2. Each storey: a 16 m by 10 m slab, 0.2 m thick, min corner at the origin; four perimeter walls 0.3 m thick, 3 m high on the slab; and one interior partition wall 0.15 m thick, 3 m high at x = 6 spanning the full 10 m depth. Ground floor only: one door 1.0 m wide by 2.1 m high at the centre of the partition, and four windows (1.5 m by 1.2 m, sill 0.9 m) in the north wall (the 16 m wall along y = 10). Upper floor only: six windows of the same size, three in its north wall and three in its south wall. Each storey also gets two spaces on the slab, 2.8 m high: 5.5 m by 9 m west of the partition and 9.5 m by 9 m east of it, so the room areas total 270 m2. Finally set Reference = "STUDIO" in property set "Pset_SpaceCommon" on every space.',
    stated: [
      { op: 'add_window', field: 'width', value: 1.5 },
      { op: 'add_window', field: 'height', value: 1.2 },
      { op: 'add_window', field: 'sill', value: 0.9 },
      { op: 'add_door', field: 'width', value: 1.0 },
      { op: 'create_space', field: 'height', value: 2.8 },
    ],
    criteria: [
      count('storeys = 2', 'storeys', 2),
      count('slabs = 2', 'slabs', 2),
      count('walls = 10', 'walls', 10),
      count('doors = 1', 'doors', 1),
      count('windows = 10', 'windows', 10),
      count('spaces = 4', 'spaces', 4),
      tight('total glazed area 18 m2', (m) => m.windowArea, 18),
      tight('total room area 270 m2', (m) => m.spaceArea, 270),
      tight('largest room 85.5 m2', (m) => m.spaceAreas.at(-1), 85.5),
      overlapFree(),
      openingsContained(),
      {
        name: 'Reference STUDIO on all spaces', type: 'property',
        eval: (m) => m.propertyFraction('IFCSPACE', 'Pset_SpaceCommon', 'Reference', 'STUDIO'),
      },
    ],
  },
  {
    id: 'T2-11', difficulty: 'tier2-trap', name: 'packed facade 8m',
    brief: 'One storey at elevation 0 with a single straight wall, 8 m long, 0.3 m thick, 3 m high, carrying exactly five windows, each 1.5 m wide and 1.1 m high with a 0.8 m sill. The windows must not overlap - they occupy 7.5 m of the 8 m wall, so choose the along positions carefully.',
    stated: [
      { op: 'add_window', field: 'width', value: 1.5 },
      { op: 'add_window', field: 'height', value: 1.1 },
      { op: 'add_window', field: 'sill', value: 0.8 },
      { op: 'create_wall', field: 'height', value: 3 },
    ],
    criteria: [
      count('storeys = 1', 'storeys', 1),
      count('walls = 1', 'walls', 1),
      count('windows = 5', 'windows', 5),
      tight('total glazed area 8.25 m2', (m) => m.windowArea, 8.25),
      tight('gross wall area 24 m2', (m) => m.wallGrossArea, 24),
      overlapFree(),
      openingsContained(),
    ],
  },
  {
    id: 'T2-12', difficulty: 'tier2-arith', name: 'computed ratio 25',
    brief: 'One storey at elevation 0 with a single facade wall, 12 m long, 0.3 m thick, 3 m high. Add exactly four identical non-overlapping windows, sized and placed by you so that the total glazed area is exactly 25 percent of the 36 m2 facade. You choose the window width, height and sill; all four windows must be the same size.',
    stated: [
      { op: 'create_wall', field: 'height', value: 3 },
      { op: 'create_wall', field: 'thickness', value: 0.3 },
    ],
    criteria: [
      count('walls = 1', 'walls', 1),
      count('windows = 4', 'windows', 4),
      tight('total glazed area 9 m2', (m) => m.windowArea, 9),
      tight('glazing ratio 0.25', (m) => (m.wallGrossArea > 0 ? m.windowArea / m.wallGrossArea : null), 0.25),
      tight('smallest window 2.25 m2', (m) => m.windowAreas[0], 2.25),
      tight('largest window 2.25 m2', (m) => m.windowAreas.at(-1), 2.25),
      overlapFree(),
      openingsContained(),
    ],
  },
  {
    id: 'T2-13', difficulty: 'tier2-arith', name: 'area budget 144',
    brief: 'A single-storey lab building at elevation 0: an 18 m by 10 m slab, 0.25 m thick, min corner at the origin, and exactly three spaces standing on the slab, all 2.8 m high: two labs of 54 m2 each and one lounge of 36 m2, so the room areas sum to exactly 144 m2. Every space must lie fully inside the 18 by 10 footprint.',
    stated: [
      { op: 'create_space', field: 'height', value: 2.8 },
    ],
    criteria: [
      count('slabs = 1', 'slabs', 1),
      count('spaces = 3', 'spaces', 3),
      value('slab X extent 18 m', (m) => m.footprint?.dx, 18),
      tight('total room area 144 m2', (m) => m.spaceArea, 144),
      tight('smallest room 36 m2', (m) => m.spaceAreas[0], 36),
      tight('largest room 54 m2', (m) => m.spaceAreas.at(-1), 54),
    ],
  },
  {
    id: 'T2-14', difficulty: 'tier2-scale', name: 'graded tower 3',
    brief: 'Three storeys at elevations 0, 2.9 and 5.8. Every storey has a 10 m by 8 m slab, 0.2 m thick, min corner at the origin, and one facade wall 10 m long along the south edge of its slab, 0.25 m thick, 2.5 m high, standing on the slab. All windows are 0.9 m wide by 0.9 m high with a 0.9 m sill. Storey 1 gets 2 windows, storey 2 gets 3 and storey 3 gets 4 - nine in total, none overlapping.',
    stated: [
      { op: 'add_window', field: 'width', value: 0.9 },
      { op: 'add_window', field: 'height', value: 0.9 },
      { op: 'add_window', field: 'sill', value: 0.9 },
      { op: 'create_wall', field: 'height', value: 2.5 },
    ],
    criteria: [
      count('storeys = 3', 'storeys', 3),
      count('slabs = 3', 'slabs', 3),
      count('walls = 3', 'walls', 3),
      count('windows = 9', 'windows', 9),
      tight('total glazed area 7.29 m2', (m) => m.windowArea, 7.29),
      windowsPerBand('windows per level 2/3/4', [[0, 2.9, 2], [2.9, 5.8, 3], [5.8, 8.7, 4]]),
      openingsContained(),
    ],
  },
  {
    id: 'T2-15', difficulty: 'tier2-scale', name: 'frame 18',
    brief: 'A two-storey frame with storeys at elevations 0 and 3.0. Each storey has: a 12 m by 9 m slab, 0.2 m thick, min corner at the origin; nine columns (0.3 m by 0.3 m section, 2.6 m high) standing on the slab in a 3 by 3 grid at x in {2, 6, 10} and y in {1.5, 4.5, 7.5}; and three beams (0.3 m wide, 0.4 m deep) at the column heads, one per row y in {1.5, 4.5, 7.5}, each spanning in X from x = 2 to x = 10.',
    stated: [
      { op: 'create_column', field: 'width', value: 0.3 },
      { op: 'create_column', field: 'height', value: 2.6 },
      { op: 'create_beam', field: 'width', value: 0.3 },
      { op: 'create_beam', field: 'height', value: 0.4 },
    ],
    criteria: [
      count('storeys = 2', 'storeys', 2),
      count('slabs = 2', 'slabs', 2),
      count('columns = 18', 'columns', 18),
      count('beams = 6', 'beams', 6),
      value('slab X extent 12 m', (m) => m.footprint?.dx, 12),
      gridMatch('columns on 3x3 grid', 'columns', [2, 6, 10], [1.5, 4.5, 7.5]),
    ],
  },
  {
    id: 'T2-16', difficulty: 'tier2-arith', name: 'facade with door 12',
    brief: 'A single-storey house at elevation 0: a 12 m by 8 m slab, 0.2 m thick, min corner at the origin, and four perimeter walls, 0.25 m thick, 2.8 m high, on top of the slab. The south wall (the 12 m wall along y = 0) must reach exactly 25 percent glazing of its 33.6 m2 face using four identical windows of 2.1 m2 each (1.4 m wide by 1.5 m high, sill 0.9 m), and additionally carries one entrance door 0.9 m wide by 2.1 m high. Nothing on that wall may overlap.',
    stated: [
      { op: 'add_window', field: 'width', value: 1.4 },
      { op: 'add_window', field: 'height', value: 1.5 },
      { op: 'add_window', field: 'sill', value: 0.9 },
      { op: 'add_door', field: 'width', value: 0.9 },
      { op: 'add_door', field: 'height', value: 2.1 },
    ],
    criteria: [
      count('walls = 4', 'walls', 4),
      count('windows = 4', 'windows', 4),
      count('doors = 1', 'doors', 1),
      value('slab X extent 12 m', (m) => m.footprint?.dx, 12),
      tight('total glazed area 8.4 m2', (m) => m.windowArea, 8.4),
      overlapFree(),
      openingsContained(),
    ],
  },
  {
    id: 'T2-17', difficulty: 'tier2-scale', name: 'properties square',
    brief: 'One storey at elevation 0: a 12 m by 12 m slab, 0.2 m thick, min corner at the origin; four perimeter walls, 0.3 m thick, 3 m high, on the slab; and four columns (0.35 m by 0.35 m, 3 m high) on the slab at the corners of the inner square x in {3, 9}, y in {3, 9}. Set FireRating = "REI120" in property set "Pset_WallCommon" on EVERY wall and Reference = "C30" in property set "Pset_ColumnCommon" on EVERY column.',
    stated: [
      { op: 'create_column', field: 'width', value: 0.35 },
      { op: 'create_column', field: 'height', value: 3 },
      { op: 'create_wall', field: 'height', value: 3 },
    ],
    criteria: [
      count('storeys = 1', 'storeys', 1),
      count('walls = 4', 'walls', 4),
      count('columns = 4', 'columns', 4),
      gridMatch('columns on inner square', 'columns', [3, 9], [3, 9]),
      {
        name: 'FireRating REI120 on all walls', type: 'property',
        eval: (m) => m.propertyFraction('IFCWALL', 'Pset_WallCommon', 'FireRating', 'REI120'),
      },
      {
        name: 'Reference C30 on all columns', type: 'property',
        eval: (m) => m.propertyFraction('IFCCOLUMN', 'Pset_ColumnCommon', 'Reference', 'C30'),
      },
    ],
  },
  {
    id: 'T2-18', difficulty: 'tier2-trap', name: 'three tight doors',
    brief: 'One storey at elevation 0 with a single wall, 4.2 m long, 0.2 m thick, 2.4 m high, carrying exactly three doors, each 1.3 m wide and 2.0 m high, that must not overlap - the doors occupy 3.9 m of the 4.2 m wall, so choose the along positions carefully.',
    stated: [
      { op: 'add_door', field: 'width', value: 1.3 },
      { op: 'add_door', field: 'height', value: 2.0 },
      { op: 'create_wall', field: 'height', value: 2.4 },
    ],
    criteria: [
      count('walls = 1', 'walls', 1),
      count('doors = 3', 'doors', 3),
      tight('gross wall area 10.08 m2', (m) => m.wallGrossArea, 10.08),
      value('overall height 2.4 m', (m) => m.overall?.dz, 2.4),
      overlapFree(),
      openingsContained(),
    ],
  },
  {
    id: 'T2-19', difficulty: 'tier2-scale', name: 'asymmetric storeys',
    brief: 'A two-storey house with storeys at elevations 0 and 3.0. Each storey has a 14 m by 8 m slab, 0.2 m thick, min corner at the origin. The GROUND storey has four perimeter walls, 0.25 m thick, 2.8 m high, on its slab, with one door 1.1 m wide by 2.1 m high in the south wall and two windows in the north wall. The UPPER storey has only two walls (south and north, both 14 m, 0.25 m thick, 2.8 m high) with four windows in each. All ten windows are 1.2 m wide by 1.4 m high with a 0.9 m sill, none overlapping.',
    stated: [
      { op: 'add_window', field: 'width', value: 1.2 },
      { op: 'add_window', field: 'height', value: 1.4 },
      { op: 'add_window', field: 'sill', value: 0.9 },
      { op: 'add_door', field: 'width', value: 1.1 },
      { op: 'add_door', field: 'height', value: 2.1 },
    ],
    criteria: [
      count('storeys = 2', 'storeys', 2),
      count('walls = 6', 'walls', 6),
      count('windows = 10', 'windows', 10),
      count('doors = 1', 'doors', 1),
      tight('total glazed area 16.8 m2', (m) => m.windowArea, 16.8),
      value('overall height 6 m', (m) => m.overall?.dz, 6),
      windowsPerBand('windows per storey 2/8', [[0, 3, 2], [3, 6, 8]]),
      openingsContained(),
    ],
  },
  {
    id: 'T2-20', difficulty: 'tier2-capstone', name: 'small studio',
    brief: 'A two-storey building with storeys at elevations 0 and 3.0. Each storey: a 12 m by 9 m slab, 0.2 m thick, min corner at the origin; four perimeter walls 0.25 m thick, 2.8 m high on the slab; and one interior partition wall 0.12 m thick, 2.8 m high at x = 5 spanning the full 9 m depth. Ground floor only: one door 0.9 m wide by 2.1 m high at the centre of the partition, and three windows (1.4 m by 1.2 m, sill 0.9 m) in the north wall. Upper floor only: six windows of the same size, three in its north wall and three in its south wall. Each storey also gets two spaces on the slab, 2.8 m high: 4.5 m by 8 m west of the partition and 6.5 m by 8 m east of it, so the room areas total 176 m2. Set Reference = "ROOM" in property set "Pset_SpaceCommon" on every space.',
    stated: [
      { op: 'add_window', field: 'width', value: 1.4 },
      { op: 'add_window', field: 'height', value: 1.2 },
      { op: 'add_window', field: 'sill', value: 0.9 },
      { op: 'add_door', field: 'width', value: 0.9 },
      { op: 'create_space', field: 'height', value: 2.8 },
    ],
    criteria: [
      count('storeys = 2', 'storeys', 2),
      count('slabs = 2', 'slabs', 2),
      count('walls = 10', 'walls', 10),
      count('doors = 1', 'doors', 1),
      count('windows = 9', 'windows', 9),
      count('spaces = 4', 'spaces', 4),
      tight('total glazed area 15.12 m2', (m) => m.windowArea, 15.12),
      tight('total room area 176 m2', (m) => m.spaceArea, 176),
      tight('largest room 52 m2', (m) => m.spaceAreas.at(-1), 52),
      overlapFree(),
      openingsContained(),
      {
        name: 'Reference ROOM on all spaces', type: 'property',
        eval: (m) => m.propertyFraction('IFCSPACE', 'Pset_SpaceCommon', 'Reference', 'ROOM'),
      },
    ],
  },

  // ---- Deliberately infeasible briefs (scored on infeasibility handling,
  // ---- excluded from the main quality aggregates).
  {
    id: 'T2-F1', difficulty: 'tier2-infeasible', name: 'overfull wall', infeasible: true,
    infeasibleWhy: 'five 2.0 m windows need 10 m of wall; the wall is 8 m - impossible by plain arithmetic, no hidden rule needed',
    brief: 'One storey at elevation 0 with a single straight wall, 8 m long, 0.3 m thick, 3 m high, carrying exactly five windows, each 2.0 m wide and 1.2 m high with a 0.9 m sill, none overlapping. Every stated dimension is mandatory.',
    stated: [
      { op: 'add_window', field: 'width', value: 2.0 },
      { op: 'add_window', field: 'height', value: 1.2 },
      { op: 'add_window', field: 'sill', value: 0.9 },
    ],
    criteria: [],
  },
  {
    id: 'T2-F2', difficulty: 'tier2-infeasible', name: 'window taller than wall', infeasible: true,
    infeasibleWhy: 'sill 1.0 + height 2.5 = 3.5 m on a 3 m wall - impossible by plain arithmetic, no hidden rule needed',
    brief: 'One storey at elevation 0 with a single straight wall, 7 m long, 0.3 m thick, 3 m high, containing exactly two windows, each 1.4 m wide and 2.5 m high with the sill at exactly 1.0 m. Every stated dimension is mandatory.',
    stated: [
      { op: 'add_window', field: 'width', value: 1.4 },
      { op: 'add_window', field: 'height', value: 2.5 },
      { op: 'add_window', field: 'sill', value: 1.0 },
    ],
    criteria: [],
  },
  {
    id: 'T2-F3', difficulty: 'tier2-infeasible', name: 'flush head', infeasible: true,
    infeasibleWhy: 'sill 1.1 + height 1.5 = 2.6 m = the wall height exactly: flush fit is geometrically imaginable but the HELD-OUT head-clearance rule (sill + height <= wallHeight - 0.05) rejects it - infeasibility discoverable only through kernel feedback',
    brief: 'One storey at elevation 0 with one wall, 10 m long, 0.3 m thick and 2.6 m high. Put exactly three non-overlapping windows in it, each 1.2 m wide and 1.5 m high, with the sill at exactly 1.1 m. Every stated dimension is mandatory.',
    stated: [
      { op: 'add_window', field: 'width', value: 1.2 },
      { op: 'add_window', field: 'height', value: 1.5 },
      { op: 'add_window', field: 'sill', value: 1.1 },
    ],
    criteria: [],
  },
];

export const FEASIBLE_TIER2 = TASKS_TIER2.filter((t) => !t.infeasible);
export const INFEASIBLE_TIER2 = TASKS_TIER2.filter((t) => t.infeasible);

/**
 * Intent-fidelity factor: the fraction of emitted ops that honor the
 * brief's explicitly stated parameter values (per `stated` spec, exact
 * match). Guards against constraint laundering - mutating a stated value
 * until the kernel accepts it. Entries with no matching ops are vacuous
 * (missing elements are already punished by count criteria).
 */
export function intentFactor(task, ops) {
  const stated = task.stated ?? [];
  if (stated.length === 0 || !Array.isArray(ops)) return 1;
  const fracs = [];
  for (const s of stated) {
    const rel = ops.filter((o) => o && o.op === s.op);
    if (rel.length === 0) continue;
    const ok = rel.filter((o) => (
      typeof s.value === 'number'
        ? typeof o[s.field] === 'number' && Math.abs(o[s.field] - s.value) <= 1e-9
        : o[s.field] === s.value
    )).length;
    fracs.push(ok / rel.length);
  }
  if (fracs.length === 0) return 1;
  return fracs.reduce((a, b) => a + b, 0) / fracs.length;
}

/**
 * Golden solutions for the 20 feasible briefs (selftest: each must pass the
 * full validator + kernel gate and score quality 1.0 including the intent
 * factor). The infeasible briefs have no golden program by definition -
 * their correct output is the infeasibility declaration.
 */
export const GOLDEN_TIER2 = {
  'T2-01': [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_wall', id: 'w1', storey: 's1', start: [0, 0, 0], end: [6, 0, 0], thickness: 0.3, height: 3 },
    { op: 'add_window', id: 'win1', wall: 'w1', along: 0.75, sill: 0.9, width: 1.4, height: 1.2 },
    { op: 'add_window', id: 'win2', wall: 'w1', along: 2.25, sill: 0.9, width: 1.4, height: 1.2 },
    { op: 'add_window', id: 'win3', wall: 'w1', along: 3.75, sill: 0.9, width: 1.4, height: 1.2 },
    { op: 'add_window', id: 'win4', wall: 'w1', along: 5.25, sill: 0.9, width: 1.4, height: 1.2 },
  ],
  'T2-02': [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_wall', id: 'w1', storey: 's1', start: [0, 0, 0], end: [9, 0, 0], thickness: 0.3, height: 3 },
    { op: 'add_window', id: 'win1', wall: 'w1', along: 1.5, sill: 0.9, width: 1.8, height: 1.5 },
    { op: 'add_window', id: 'win2', wall: 'w1', along: 4.5, sill: 0.9, width: 1.8, height: 1.5 },
    { op: 'add_window', id: 'win3', wall: 'w1', along: 7.5, sill: 0.9, width: 1.8, height: 1.5 },
  ],
  'T2-03': [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_slab', id: 'slab1', storey: 's1', position: [0, 0, 0], width: 10, depth: 6, thickness: 0.2 },
    { op: 'create_wall', id: 'w1', storey: 's1', start: [0, 0.15, 0.2], end: [10, 0.15, 0.2], thickness: 0.3, height: 2.6 },
    { op: 'add_window', id: 'win1', wall: 'w1', along: 2, sill: 1.15, width: 1.2, height: 1.4 },
    { op: 'add_window', id: 'win2', wall: 'w1', along: 5, sill: 1.15, width: 1.2, height: 1.4 },
    { op: 'add_window', id: 'win3', wall: 'w1', along: 8, sill: 1.15, width: 1.2, height: 1.4 },
  ],
  'T2-04': [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_slab', id: 'slab1', storey: 's1', position: [0, 0, 0], width: 20, depth: 12, thickness: 0.25 },
    { op: 'create_space', id: 'corridor', storey: 's1', name: 'Corridor', position: [0, 0, 0.25], width: 2.5, depth: 12, height: 2.8 },
    { op: 'create_space', id: 'meeting', storey: 's1', name: 'Meeting', position: [2.5, 0, 0.25], width: 5, depth: 10, height: 2.8 },
    { op: 'create_space', id: 'office1', storey: 's1', name: 'Office 1', position: [7.5, 0, 0.25], width: 6, depth: 10, height: 2.8 },
    { op: 'create_space', id: 'office2', storey: 's1', name: 'Office 2', position: [13.5, 0, 0.25], width: 6, depth: 10, height: 2.8 },
  ],
  'T2-05': (() => {
    const ops = [];
    const perStorey = [2, 3, 4, 5];
    for (let i = 0; i < 4; i++) {
      const sid = `l${i + 1}`;
      ops.push({ op: 'create_storey', id: sid, name: `Level ${i + 1}`, elevation: i * 3 });
      ops.push({ op: 'create_slab', id: `slab${i + 1}`, storey: sid, position: [0, 0, 0], width: 12, depth: 8, thickness: 0.2 });
      ops.push({ op: 'create_wall', id: `w${i + 1}`, storey: sid, start: [0, 0.125, 0.2], end: [12, 0.125, 0.2], thickness: 0.25, height: 2.7 });
      const n = perStorey[i];
      for (let k = 0; k < n; k++) {
        const along = (12 * (k + 1)) / (n + 1);
        ops.push({ op: 'add_window', id: `win${i + 1}-${k + 1}`, wall: `w${i + 1}`, along, sill: 1.0, width: 1.0, height: 1.0 });
      }
    }
    return ops;
  })(),
  'T2-06': (() => {
    const ops = [];
    const xs = [2, 6, 10, 14];
    const ys = [2, 6, 10];
    for (let i = 0; i < 3; i++) {
      const sid = `s${i + 1}`;
      ops.push({ op: 'create_storey', id: sid, name: `Storey ${i + 1}`, elevation: i * 3.2 });
      ops.push({ op: 'create_slab', id: `slab${i + 1}`, storey: sid, position: [0, 0, 0], width: 16, depth: 12, thickness: 0.2 });
      for (const x of xs) {
        for (const y of ys) {
          ops.push({ op: 'create_column', id: `c${i + 1}-${x}-${y}`, storey: sid, position: [x, y, 0.2], width: 0.35, depth: 0.35, height: 3 });
        }
      }
      for (const x of xs) {
        ops.push({ op: 'create_beam', id: `b${i + 1}-${x}`, storey: sid, start: [x, 2, 3.2], end: [x, 10, 3.2], width: 0.3, height: 0.5 });
      }
    }
    return ops;
  })(),
  'T2-07': [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_slab', id: 'slab1', storey: 's1', position: [0, 0, 0], width: 14, depth: 10, thickness: 0.25 },
    { op: 'create_wall', id: 'south', storey: 's1', start: [0, 0.15, 0.25], end: [14, 0.15, 0.25], thickness: 0.3, height: 3 },
    { op: 'create_wall', id: 'north', storey: 's1', start: [0, 9.85, 0.25], end: [14, 9.85, 0.25], thickness: 0.3, height: 3 },
    { op: 'create_wall', id: 'west', storey: 's1', start: [0.15, 0, 0.25], end: [0.15, 10, 0.25], thickness: 0.3, height: 3 },
    { op: 'create_wall', id: 'east', storey: 's1', start: [13.85, 0, 0.25], end: [13.85, 10, 0.25], thickness: 0.3, height: 3 },
    { op: 'add_door', id: 'door1', wall: 'south', along: 1.0, width: 1.0, height: 2.1 },
    { op: 'add_window', id: 'win1', wall: 'south', along: 3, sill: 0.9, width: 1.4, height: 1.5 },
    { op: 'add_window', id: 'win2', wall: 'south', along: 5.5, sill: 0.9, width: 1.4, height: 1.5 },
    { op: 'add_window', id: 'win3', wall: 'south', along: 8, sill: 0.9, width: 1.4, height: 1.5 },
    { op: 'add_window', id: 'win4', wall: 'south', along: 10.5, sill: 0.9, width: 1.4, height: 1.5 },
    { op: 'add_window', id: 'win5', wall: 'south', along: 13, sill: 0.9, width: 1.4, height: 1.5 },
  ],
  'T2-08': (() => {
    const ops = [];
    const storeys = [['g', 'Ground', 0], ['u', 'Upper', 3.5]];
    for (const [sid, name, elev] of storeys) {
      ops.push({ op: 'create_storey', id: sid, name, elevation: elev });
      ops.push({ op: 'create_slab', id: `slab-${sid}`, storey: sid, position: [0, 0, 0], width: 15, depth: 9, thickness: 0.2 });
      ops.push({ op: 'create_wall', id: `${sid}-south`, storey: sid, start: [0, 0.125, 0.2], end: [15, 0.125, 0.2], thickness: 0.25, height: 3.3 });
      ops.push({ op: 'create_wall', id: `${sid}-north`, storey: sid, start: [0, 8.875, 0.2], end: [15, 8.875, 0.2], thickness: 0.25, height: 3.3 });
      ops.push({ op: 'create_wall', id: `${sid}-west`, storey: sid, start: [0.125, 0, 0.2], end: [0.125, 9, 0.2], thickness: 0.25, height: 3.3 });
      ops.push({ op: 'create_wall', id: `${sid}-east`, storey: sid, start: [14.875, 0, 0.2], end: [14.875, 9, 0.2], thickness: 0.25, height: 3.3 });
    }
    let ci = 0;
    for (const y of [3, 6]) {
      for (const x of [3, 7.5, 12]) {
        ci += 1;
        ops.push({ op: 'create_column', id: `col${ci}`, storey: 'g', position: [x, y, 0.2], width: 0.4, depth: 0.4, height: 3.3 });
      }
    }
    for (const [sid] of storeys) {
      for (const side of ['south', 'north', 'west', 'east']) {
        ops.push({ op: 'set_property', target: `${sid}-${side}`, pset: 'Pset_WallCommon', name: 'FireRating', value: 'REI90' });
      }
    }
    for (let k = 1; k <= 6; k++) {
      ops.push({ op: 'set_property', target: `col${k}`, pset: 'Pset_ColumnCommon', name: 'LoadBearing', value: true });
    }
    return ops;
  })(),
  'T2-09': [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_wall', id: 'wa', storey: 's1', start: [0, 0, 0], end: [3, 0, 0], thickness: 0.2, height: 2.5 },
    { op: 'create_wall', id: 'wb', storey: 's1', start: [0, 2, 0], end: [3, 2, 0], thickness: 0.2, height: 2.5 },
    { op: 'add_door', id: 'da1', wall: 'wa', along: 0.65, width: 1.2, height: 2.1 },
    { op: 'add_door', id: 'da2', wall: 'wa', along: 1.95, width: 1.2, height: 2.1 },
    { op: 'add_door', id: 'db1', wall: 'wb', along: 0.65, width: 1.2, height: 2.1 },
    { op: 'add_door', id: 'db2', wall: 'wb', along: 1.95, width: 1.2, height: 2.1 },
  ],
  'T2-10': (() => {
    const ops = [];
    const storeys = [['g', 'Ground', 0], ['u', 'Upper', 3.2]];
    for (const [sid, name, elev] of storeys) {
      ops.push({ op: 'create_storey', id: sid, name, elevation: elev });
      ops.push({ op: 'create_slab', id: `slab-${sid}`, storey: sid, position: [0, 0, 0], width: 16, depth: 10, thickness: 0.2 });
      ops.push({ op: 'create_wall', id: `${sid}-south`, storey: sid, start: [0, 0.15, 0.2], end: [16, 0.15, 0.2], thickness: 0.3, height: 3 });
      ops.push({ op: 'create_wall', id: `${sid}-north`, storey: sid, start: [0, 9.85, 0.2], end: [16, 9.85, 0.2], thickness: 0.3, height: 3 });
      ops.push({ op: 'create_wall', id: `${sid}-west`, storey: sid, start: [0.15, 0, 0.2], end: [0.15, 10, 0.2], thickness: 0.3, height: 3 });
      ops.push({ op: 'create_wall', id: `${sid}-east`, storey: sid, start: [15.85, 0, 0.2], end: [15.85, 10, 0.2], thickness: 0.3, height: 3 });
      ops.push({ op: 'create_wall', id: `${sid}-part`, storey: sid, start: [6, 0, 0.2], end: [6, 10, 0.2], thickness: 0.15, height: 3 });
      ops.push({ op: 'create_space', id: `${sid}-west-room`, storey: sid, name: 'West Studio', position: [0.3, 0.5, 0.2], width: 5.5, depth: 9, height: 2.8 });
      ops.push({ op: 'create_space', id: `${sid}-east-room`, storey: sid, name: 'East Studio', position: [6.2, 0.5, 0.2], width: 9.5, depth: 9, height: 2.8 });
    }
    ops.push({ op: 'add_door', id: 'door1', wall: 'g-part', along: 5, width: 1.0, height: 2.1 });
    for (let k = 0; k < 4; k++) {
      ops.push({ op: 'add_window', id: `gw${k + 1}`, wall: 'g-north', along: 3 + k * 3.5, sill: 0.9, width: 1.5, height: 1.2 });
    }
    for (let k = 0; k < 3; k++) {
      ops.push({ op: 'add_window', id: `un${k + 1}`, wall: 'u-north', along: 4 + k * 4, sill: 0.9, width: 1.5, height: 1.2 });
      ops.push({ op: 'add_window', id: `us${k + 1}`, wall: 'u-south', along: 4 + k * 4, sill: 0.9, width: 1.5, height: 1.2 });
    }
    for (const [sid] of storeys) {
      ops.push({ op: 'set_property', target: `${sid}-west-room`, pset: 'Pset_SpaceCommon', name: 'Reference', value: 'STUDIO' });
      ops.push({ op: 'set_property', target: `${sid}-east-room`, pset: 'Pset_SpaceCommon', name: 'Reference', value: 'STUDIO' });
    }
    return ops;
  })(),
  'T2-11': [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_wall', id: 'w1', storey: 's1', start: [0, 0, 0], end: [8, 0, 0], thickness: 0.3, height: 3 },
    { op: 'add_window', id: 'win1', wall: 'w1', along: 0.8, sill: 0.8, width: 1.5, height: 1.1 },
    { op: 'add_window', id: 'win2', wall: 'w1', along: 2.4, sill: 0.8, width: 1.5, height: 1.1 },
    { op: 'add_window', id: 'win3', wall: 'w1', along: 4.0, sill: 0.8, width: 1.5, height: 1.1 },
    { op: 'add_window', id: 'win4', wall: 'w1', along: 5.6, sill: 0.8, width: 1.5, height: 1.1 },
    { op: 'add_window', id: 'win5', wall: 'w1', along: 7.2, sill: 0.8, width: 1.5, height: 1.1 },
  ],
  'T2-12': [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_wall', id: 'w1', storey: 's1', start: [0, 0, 0], end: [12, 0, 0], thickness: 0.3, height: 3 },
    { op: 'add_window', id: 'win1', wall: 'w1', along: 1.5, sill: 0.8, width: 1.5, height: 1.5 },
    { op: 'add_window', id: 'win2', wall: 'w1', along: 4.5, sill: 0.8, width: 1.5, height: 1.5 },
    { op: 'add_window', id: 'win3', wall: 'w1', along: 7.5, sill: 0.8, width: 1.5, height: 1.5 },
    { op: 'add_window', id: 'win4', wall: 'w1', along: 10.5, sill: 0.8, width: 1.5, height: 1.5 },
  ],
  'T2-13': [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_slab', id: 'slab1', storey: 's1', position: [0, 0, 0], width: 18, depth: 10, thickness: 0.25 },
    { op: 'create_space', id: 'lab1', storey: 's1', name: 'Lab 1', position: [0, 0, 0.25], width: 6, depth: 9, height: 2.8 },
    { op: 'create_space', id: 'lab2', storey: 's1', name: 'Lab 2', position: [6, 0, 0.25], width: 6, depth: 9, height: 2.8 },
    { op: 'create_space', id: 'lounge', storey: 's1', name: 'Lounge', position: [12, 0, 0.25], width: 4, depth: 9, height: 2.8 },
  ],
  'T2-14': (() => {
    const ops = [];
    const perStorey = [2, 3, 4];
    for (let i = 0; i < 3; i++) {
      const sid = `l${i + 1}`;
      ops.push({ op: 'create_storey', id: sid, name: `Storey ${i + 1}`, elevation: i * 2.9 });
      ops.push({ op: 'create_slab', id: `slab${i + 1}`, storey: sid, position: [0, 0, 0], width: 10, depth: 8, thickness: 0.2 });
      ops.push({ op: 'create_wall', id: `w${i + 1}`, storey: sid, start: [0, 0.125, 0.2], end: [10, 0.125, 0.2], thickness: 0.25, height: 2.5 });
      const n = perStorey[i];
      for (let k = 0; k < n; k++) {
        const along = (10 * (k + 1)) / (n + 1);
        ops.push({ op: 'add_window', id: `win${i + 1}-${k + 1}`, wall: `w${i + 1}`, along, sill: 0.9, width: 0.9, height: 0.9 });
      }
    }
    return ops;
  })(),
  'T2-15': (() => {
    const ops = [];
    const xs = [2, 6, 10];
    const ys = [1.5, 4.5, 7.5];
    for (let i = 0; i < 2; i++) {
      const sid = `s${i + 1}`;
      ops.push({ op: 'create_storey', id: sid, name: `Storey ${i + 1}`, elevation: i * 3.0 });
      ops.push({ op: 'create_slab', id: `slab${i + 1}`, storey: sid, position: [0, 0, 0], width: 12, depth: 9, thickness: 0.2 });
      for (const x of xs) {
        for (const y of ys) {
          ops.push({ op: 'create_column', id: `c${i + 1}-${x}-${y * 10}`, storey: sid, position: [x, y, 0.2], width: 0.3, depth: 0.3, height: 2.6 });
        }
      }
      for (const y of ys) {
        ops.push({ op: 'create_beam', id: `b${i + 1}-${y * 10}`, storey: sid, start: [2, y, 2.8], end: [10, y, 2.8], width: 0.3, height: 0.4 });
      }
    }
    return ops;
  })(),
  'T2-16': [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_slab', id: 'slab1', storey: 's1', position: [0, 0, 0], width: 12, depth: 8, thickness: 0.2 },
    { op: 'create_wall', id: 'south', storey: 's1', start: [0, 0.125, 0.2], end: [12, 0.125, 0.2], thickness: 0.25, height: 2.8 },
    { op: 'create_wall', id: 'north', storey: 's1', start: [0, 7.875, 0.2], end: [12, 7.875, 0.2], thickness: 0.25, height: 2.8 },
    { op: 'create_wall', id: 'west', storey: 's1', start: [0.125, 0, 0.2], end: [0.125, 8, 0.2], thickness: 0.25, height: 2.8 },
    { op: 'create_wall', id: 'east', storey: 's1', start: [11.875, 0, 0.2], end: [11.875, 8, 0.2], thickness: 0.25, height: 2.8 },
    { op: 'add_door', id: 'door1', wall: 'south', along: 1.2, width: 0.9, height: 2.1 },
    { op: 'add_window', id: 'win1', wall: 'south', along: 3.5, sill: 0.9, width: 1.4, height: 1.5 },
    { op: 'add_window', id: 'win2', wall: 'south', along: 5.9, sill: 0.9, width: 1.4, height: 1.5 },
    { op: 'add_window', id: 'win3', wall: 'south', along: 8.3, sill: 0.9, width: 1.4, height: 1.5 },
    { op: 'add_window', id: 'win4', wall: 'south', along: 10.7, sill: 0.9, width: 1.4, height: 1.5 },
  ],
  'T2-17': [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_slab', id: 'slab1', storey: 's1', position: [0, 0, 0], width: 12, depth: 12, thickness: 0.2 },
    { op: 'create_wall', id: 'south', storey: 's1', start: [0, 0.15, 0.2], end: [12, 0.15, 0.2], thickness: 0.3, height: 3 },
    { op: 'create_wall', id: 'north', storey: 's1', start: [0, 11.85, 0.2], end: [12, 11.85, 0.2], thickness: 0.3, height: 3 },
    { op: 'create_wall', id: 'west', storey: 's1', start: [0.15, 0, 0.2], end: [0.15, 12, 0.2], thickness: 0.3, height: 3 },
    { op: 'create_wall', id: 'east', storey: 's1', start: [11.85, 0, 0.2], end: [11.85, 12, 0.2], thickness: 0.3, height: 3 },
    { op: 'create_column', id: 'c1', storey: 's1', position: [3, 3, 0.2], width: 0.35, depth: 0.35, height: 3 },
    { op: 'create_column', id: 'c2', storey: 's1', position: [9, 3, 0.2], width: 0.35, depth: 0.35, height: 3 },
    { op: 'create_column', id: 'c3', storey: 's1', position: [3, 9, 0.2], width: 0.35, depth: 0.35, height: 3 },
    { op: 'create_column', id: 'c4', storey: 's1', position: [9, 9, 0.2], width: 0.35, depth: 0.35, height: 3 },
    { op: 'set_property', target: 'south', pset: 'Pset_WallCommon', name: 'FireRating', value: 'REI120' },
    { op: 'set_property', target: 'north', pset: 'Pset_WallCommon', name: 'FireRating', value: 'REI120' },
    { op: 'set_property', target: 'west', pset: 'Pset_WallCommon', name: 'FireRating', value: 'REI120' },
    { op: 'set_property', target: 'east', pset: 'Pset_WallCommon', name: 'FireRating', value: 'REI120' },
    { op: 'set_property', target: 'c1', pset: 'Pset_ColumnCommon', name: 'Reference', value: 'C30' },
    { op: 'set_property', target: 'c2', pset: 'Pset_ColumnCommon', name: 'Reference', value: 'C30' },
    { op: 'set_property', target: 'c3', pset: 'Pset_ColumnCommon', name: 'Reference', value: 'C30' },
    { op: 'set_property', target: 'c4', pset: 'Pset_ColumnCommon', name: 'Reference', value: 'C30' },
  ],
  'T2-18': [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_wall', id: 'w1', storey: 's1', start: [0, 0, 0], end: [4.2, 0, 0], thickness: 0.2, height: 2.4 },
    { op: 'add_door', id: 'd1', wall: 'w1', along: 0.75, width: 1.3, height: 2.0 },
    { op: 'add_door', id: 'd2', wall: 'w1', along: 2.1, width: 1.3, height: 2.0 },
    { op: 'add_door', id: 'd3', wall: 'w1', along: 3.45, width: 1.3, height: 2.0 },
  ],
  'T2-19': (() => {
    const ops = [];
    ops.push({ op: 'create_storey', id: 'g', name: 'Ground', elevation: 0 });
    ops.push({ op: 'create_slab', id: 'slab-g', storey: 'g', position: [0, 0, 0], width: 14, depth: 8, thickness: 0.2 });
    ops.push({ op: 'create_wall', id: 'g-south', storey: 'g', start: [0, 0.125, 0.2], end: [14, 0.125, 0.2], thickness: 0.25, height: 2.8 });
    ops.push({ op: 'create_wall', id: 'g-north', storey: 'g', start: [0, 7.875, 0.2], end: [14, 7.875, 0.2], thickness: 0.25, height: 2.8 });
    ops.push({ op: 'create_wall', id: 'g-west', storey: 'g', start: [0.125, 0, 0.2], end: [0.125, 8, 0.2], thickness: 0.25, height: 2.8 });
    ops.push({ op: 'create_wall', id: 'g-east', storey: 'g', start: [13.875, 0, 0.2], end: [13.875, 8, 0.2], thickness: 0.25, height: 2.8 });
    ops.push({ op: 'add_door', id: 'door1', wall: 'g-south', along: 2, width: 1.1, height: 2.1 });
    ops.push({ op: 'add_window', id: 'gw1', wall: 'g-north', along: 5, sill: 0.9, width: 1.2, height: 1.4 });
    ops.push({ op: 'add_window', id: 'gw2', wall: 'g-north', along: 9, sill: 0.9, width: 1.2, height: 1.4 });
    ops.push({ op: 'create_storey', id: 'u', name: 'Upper', elevation: 3.0 });
    ops.push({ op: 'create_slab', id: 'slab-u', storey: 'u', position: [0, 0, 0], width: 14, depth: 8, thickness: 0.2 });
    ops.push({ op: 'create_wall', id: 'u-south', storey: 'u', start: [0, 0.125, 0.2], end: [14, 0.125, 0.2], thickness: 0.25, height: 2.8 });
    ops.push({ op: 'create_wall', id: 'u-north', storey: 'u', start: [0, 7.875, 0.2], end: [14, 7.875, 0.2], thickness: 0.25, height: 2.8 });
    for (let k = 0; k < 4; k++) {
      ops.push({ op: 'add_window', id: `us${k + 1}`, wall: 'u-south', along: 2.8 * (k + 1), sill: 0.9, width: 1.2, height: 1.4 });
      ops.push({ op: 'add_window', id: `un${k + 1}`, wall: 'u-north', along: 2.8 * (k + 1), sill: 0.9, width: 1.2, height: 1.4 });
    }
    return ops;
  })(),
  'T2-20': (() => {
    const ops = [];
    const storeys = [['g', 'Ground', 0], ['u', 'Upper', 3.0]];
    for (const [sid, name, elev] of storeys) {
      ops.push({ op: 'create_storey', id: sid, name, elevation: elev });
      ops.push({ op: 'create_slab', id: `slab-${sid}`, storey: sid, position: [0, 0, 0], width: 12, depth: 9, thickness: 0.2 });
      ops.push({ op: 'create_wall', id: `${sid}-south`, storey: sid, start: [0, 0.125, 0.2], end: [12, 0.125, 0.2], thickness: 0.25, height: 2.8 });
      ops.push({ op: 'create_wall', id: `${sid}-north`, storey: sid, start: [0, 8.875, 0.2], end: [12, 8.875, 0.2], thickness: 0.25, height: 2.8 });
      ops.push({ op: 'create_wall', id: `${sid}-west`, storey: sid, start: [0.125, 0, 0.2], end: [0.125, 9, 0.2], thickness: 0.25, height: 2.8 });
      ops.push({ op: 'create_wall', id: `${sid}-east`, storey: sid, start: [11.875, 0, 0.2], end: [11.875, 9, 0.2], thickness: 0.25, height: 2.8 });
      ops.push({ op: 'create_wall', id: `${sid}-part`, storey: sid, start: [5, 0, 0.2], end: [5, 9, 0.2], thickness: 0.12, height: 2.8 });
      ops.push({ op: 'create_space', id: `${sid}-west-room`, storey: sid, name: 'West Room', position: [0.25, 0.5, 0.2], width: 4.5, depth: 8, height: 2.8 });
      ops.push({ op: 'create_space', id: `${sid}-east-room`, storey: sid, name: 'East Room', position: [5.2, 0.5, 0.2], width: 6.5, depth: 8, height: 2.8 });
    }
    ops.push({ op: 'add_door', id: 'door1', wall: 'g-part', along: 4.5, width: 0.9, height: 2.1 });
    for (let k = 0; k < 3; k++) {
      ops.push({ op: 'add_window', id: `gn${k + 1}`, wall: 'g-north', along: 3 + k * 3, sill: 0.9, width: 1.4, height: 1.2 });
      ops.push({ op: 'add_window', id: `un${k + 1}`, wall: 'u-north', along: 3 + k * 3, sill: 0.9, width: 1.4, height: 1.2 });
      ops.push({ op: 'add_window', id: `usx${k + 1}`, wall: 'u-south', along: 3 + k * 3, sill: 0.9, width: 1.4, height: 1.2 });
    }
    for (const [sid] of storeys) {
      ops.push({ op: 'set_property', target: `${sid}-west-room`, pset: 'Pset_SpaceCommon', name: 'Reference', value: 'ROOM' });
      ops.push({ op: 'set_property', target: `${sid}-east-room`, pset: 'Pset_SpaceCommon', name: 'Reference', value: 'ROOM' });
    }
    return ops;
  })(),
};
