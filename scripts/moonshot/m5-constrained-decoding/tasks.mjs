/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The M5 exam task set: 12 natural-language briefs of graded difficulty,
 * each with machine-checkable success criteria evaluated on the COMPILED
 * IFC (via kernel.mjs measureModel), never on the op list.
 *
 * Scoring rubric (documented in DESIGN.md):
 * - count criterion: score 1 if the measured entity count equals the
 *   target exactly, else max(0, 1 - |diff| / max(target, 1)).
 * - value criterion (dimension / area, metres or m2): relative error
 *   re = |measured - target| / target; score 1 if re <= 0.05, else
 *   max(0, 1 - (re - 0.05) / 0.45) (zero credit at >= 50% error).
 * - property criterion: the measured fraction of matching elements.
 * - task quality = gate * schemaFactor * clashFactor * mean(criterion scores)
 *   where gate = 0 when the model has no meshed geometry at all,
 *   schemaFactor = 1 if kernel validation reports zero errors else 0,
 *   clashFactor = 1 / (1 + detected clashes) (M2 clashScore channel).
 */

function count(name, key, target) {
  return { name, type: 'count', key, target };
}

function value(name, get, target) {
  return { name, type: 'value', get, target };
}

export const TASKS = [
  {
    id: 'T01', difficulty: 'easy', name: 'one slab',
    brief: 'One building storey named Ground at elevation 0 with a single floor slab, 10 m wide (X) by 8 m deep (Y), 0.2 m thick, min corner at the origin.',
    criteria: [
      count('storeys = 1', 'storeys', 1),
      count('slabs = 1', 'slabs', 1),
      value('slab X extent 10 m', (m) => m.footprint?.dx, 10),
      value('slab Y extent 8 m', (m) => m.footprint?.dy, 8),
    ],
  },
  {
    id: 'T02', difficulty: 'easy', name: 'four walls on a slab',
    brief: 'One storey at elevation 0: a 12 m by 8 m slab, 0.2 m thick, min corner at the origin, and four perimeter walls (0.2 m thick, 3 m high) standing on top of the slab along its four edges, so the total built height is 3.2 m.',
    criteria: [
      count('storeys = 1', 'storeys', 1),
      count('slabs = 1', 'slabs', 1),
      count('walls = 4', 'walls', 4),
      value('overall height 3.2 m', (m) => m.overall?.dz, 3.2),
      value('slab X extent 12 m', (m) => m.footprint?.dx, 12),
    ],
  },
  {
    id: 'T03', difficulty: 'easy', name: 'punched wall',
    brief: 'One storey at elevation 0 with a single straight wall, 6 m long, 0.3 m thick, 3 m high, containing exactly two windows, each 1.2 m wide and 1.4 m high with a 0.9 m sill, placed so they do not overlap.',
    criteria: [
      count('walls = 1', 'walls', 1),
      count('windows = 2', 'windows', 2),
      value('total glazed area 3.36 m2', (m) => m.windowArea, 3.36),
    ],
  },
  {
    id: 'T04', difficulty: 'easy', name: 'column grid',
    brief: 'One storey at elevation 0: a 12 m by 6 m slab, 0.2 m thick, min corner at the origin, and six columns (0.3 m by 0.3 m section, 3 m high) standing on the slab in a 3 by 2 grid.',
    criteria: [
      count('storeys = 1', 'storeys', 1),
      count('slabs = 1', 'slabs', 1),
      count('columns = 6', 'columns', 6),
      value('overall height 3.2 m', (m) => m.overall?.dz, 3.2),
    ],
  },
  {
    id: 'T05', difficulty: 'medium', name: 'small house',
    brief: 'A single-storey house at elevation 0: a 12 m by 10 m floor slab, 0.25 m thick, min corner at the origin; four perimeter walls, 0.3 m thick, 3 m high, on top of the slab; one entrance door 1.0 m wide by 2.1 m high in the south wall (the wall along y = 0); and three windows, each 1.5 m wide by 1.2 m high with a 1.0 m sill, distributed over the other walls.',
    criteria: [
      count('walls = 4', 'walls', 4),
      count('doors = 1', 'doors', 1),
      count('windows = 3', 'windows', 3),
      value('slab X extent 12 m', (m) => m.footprint?.dx, 12),
      value('slab Y extent 10 m', (m) => m.footprint?.dy, 10),
      value('total glazed area 5.4 m2', (m) => m.windowArea, 5.4),
    ],
  },
  {
    id: 'T06', difficulty: 'medium', name: 'two-storey spaces',
    brief: 'Two storeys, Ground at elevation 0 and Level 1 at elevation 3.2. Each storey has a 10 m by 8 m slab, 0.2 m thick, min corner at the origin, and one space (room) of 5 m by 4 m, 2.8 m high, sitting on the slab.',
    criteria: [
      count('storeys = 2', 'storeys', 2),
      count('slabs = 2', 'slabs', 2),
      count('spaces = 2', 'spaces', 2),
      value('total room floor area 40 m2', (m) => m.spaceArea, 40),
    ],
  },
  {
    id: 'T07', difficulty: 'medium', name: 'glazing ratio',
    brief: 'One storey at elevation 0 with a single south facade wall, 10 m long, 0.3 m thick, 3 m high. Give it exactly three identical non-overlapping windows sized so the total glazed area is 7.5 m2, i.e. 25 percent of the 30 m2 facade.',
    criteria: [
      count('walls = 1', 'walls', 1),
      count('windows = 3', 'windows', 3),
      value('total glazed area 7.5 m2', (m) => m.windowArea, 7.5),
      value('glazing ratio 0.25', (m) => (m.wallGrossArea > 0 ? m.windowArea / m.wallGrossArea : null), 0.25),
    ],
  },
  {
    id: 'T08', difficulty: 'medium', name: 'warehouse',
    brief: 'A single-storey warehouse at elevation 0: a 20 m by 15 m slab, 0.3 m thick, min corner at the origin; four perimeter walls 0.3 m thick and 6 m high on the slab; and three columns (0.4 m by 0.4 m, 6 m high) along the centreline y = 7.5 at x = 5, 10 and 15.',
    criteria: [
      count('slabs = 1', 'slabs', 1),
      count('walls = 4', 'walls', 4),
      count('columns = 3', 'columns', 3),
      value('slab X extent 20 m', (m) => m.footprint?.dx, 20),
      value('slab Y extent 15 m', (m) => m.footprint?.dy, 15),
      value('overall height 6.3 m', (m) => m.overall?.dz, 6.3),
    ],
  },
  {
    id: 'T09', difficulty: 'hard', name: 'three-storey frame',
    brief: 'A three-storey concrete frame with storeys at elevations 0, 3 and 6. Each storey has: a 10 m by 10 m slab, 0.2 m thick, min corner at the origin; four columns (0.35 m by 0.35 m, 2.8 m high) at the corners of the inner square from (2.5, 2.5) to (7.5, 7.5), standing on the slab; and two beams (0.3 m wide, 0.5 m deep) spanning in Y between the column heads on each column line.',
    criteria: [
      count('storeys = 3', 'storeys', 3),
      count('slabs = 3', 'slabs', 3),
      count('columns = 12', 'columns', 12),
      count('beams = 6', 'beams', 6),
    ],
  },
  {
    id: 'T10', difficulty: 'hard', name: 'office floor areas',
    brief: 'A single-storey office at elevation 0: a 24 m by 12 m slab, 0.25 m thick, min corner at the origin; four perimeter walls, 0.25 m thick, 3 m high, on the slab; and exactly two spaces on the slab, one of 12 m by 10 m and one of 10 m by 10 m (both 2.75 m high), so the net room area totals 220 m2.',
    criteria: [
      count('walls = 4', 'walls', 4),
      count('spaces = 2', 'spaces', 2),
      value('slab X extent 24 m', (m) => m.footprint?.dx, 24),
      value('total room floor area 220 m2', (m) => m.spaceArea, 220),
      value('larger room 120 m2', (m) => m.spaceAreas.at(-1), 120),
    ],
  },
  {
    id: 'T11', difficulty: 'hard', name: 'mixed program with properties',
    brief: 'Two storeys at elevations 0 and 3.5. Each storey: a 15 m by 9 m slab, 0.2 m thick, min corner at the origin, and four perimeter walls, 0.25 m thick, 3.3 m high, on the slab. Add three windows per storey (six total), each 1.5 m by 1.5 m with a 0.9 m sill, and one entrance door (1.2 m wide, 2.4 m high) in a ground-floor wall. Finally set the property FireRating = "REI60" in property set "Pset_WallCommon" on EVERY wall.',
    criteria: [
      count('storeys = 2', 'storeys', 2),
      count('walls = 8', 'walls', 8),
      count('windows = 6', 'windows', 6),
      count('doors = 1', 'doors', 1),
      value('total glazed area 13.5 m2', (m) => m.windowArea, 13.5),
      {
        name: 'FireRating REI60 on all walls', type: 'property',
        eval: (m) => m.propertyFraction('IFCWALL', 'Pset_WallCommon', 'FireRating', 'REI60'),
      },
    ],
  },
  {
    id: 'T12', difficulty: 'hard', name: 'mini building',
    brief: 'A two-storey building with storeys at elevations 0 and 3.2. Each storey: a 15 m by 10 m slab, 0.2 m thick, min corner at the origin; four perimeter walls, 0.3 m thick, 3 m high, on the slab; and one interior partition wall (0.15 m thick, 3 m high) at x = 7.5 spanning the full depth, with a door 1.0 m wide by 2.1 m high at its centre. Each of the four long perimeter walls (the 15 m walls along y = 0 and y = 10) carries three windows of 2.0 m by 1.5 m with a 0.9 m sill, i.e. 9 m2 of glazing per long wall, 36 m2 total. Each storey also has two spaces of 7 m by 9 m (2.8 m high) on the slab, one on each side of the partition.',
    criteria: [
      count('storeys = 2', 'storeys', 2),
      count('slabs = 2', 'slabs', 2),
      count('walls = 10', 'walls', 10),
      count('doors = 2', 'doors', 2),
      count('windows = 12', 'windows', 12),
      count('spaces = 4', 'spaces', 4),
      value('total glazed area 36 m2', (m) => m.windowArea, 36),
      value('total room floor area 252 m2', (m) => m.spaceArea, 252),
    ],
  },
];

function scoreCount(measured, target) {
  if (measured === target) return 1;
  return Math.max(0, 1 - Math.abs(measured - target) / Math.max(target, 1));
}

function scoreValue(measured, target) {
  if (typeof measured !== 'number' || !Number.isFinite(measured)) return 0;
  const re = Math.abs(measured - target) / target;
  if (re <= 0.05) return 1;
  return Math.max(0, 1 - (re - 0.05) / 0.45);
}

/**
 * Score one task against a measurement record from kernel.measureModel.
 * Returns { quality, gate, schemaFactor, clashFactor, criteria: [...] }.
 */
export function scoreTask(task, m) {
  if (!m || m.meshedElements === 0) {
    return {
      quality: 0, gate: 0, schemaFactor: 0, clashFactor: 0,
      criteria: task.criteria.map((c) => ({ name: c.name, measured: null, score: 0 })),
    };
  }
  const rows = task.criteria.map((c) => {
    let measured;
    let score;
    if (c.type === 'count') {
      measured = m.counts[c.key] ?? 0;
      score = scoreCount(measured, c.target);
    } else if (c.type === 'value') {
      measured = c.get(m);
      score = scoreValue(measured, c.target);
    } else {
      measured = c.eval(m);
      score = typeof measured === 'number' ? measured : 0;
    }
    return {
      name: c.name,
      measured: typeof measured === 'number' ? Math.round(measured * 1000) / 1000 : measured ?? null,
      score: Math.round(score * 1000) / 1000,
    };
  });
  const mean = rows.reduce((a, r) => a + r.score, 0) / rows.length;
  const schemaFactor = m.schema.errors === 0 ? 1 : 0;
  const clashFactor = typeof m.clash.total === 'number' ? 1 / (1 + m.clash.total) : 1;
  return {
    quality: Math.round(mean * schemaFactor * clashFactor * 1000) / 1000,
    gate: 1,
    schemaFactor,
    clashFactor: Math.round(clashFactor * 1000) / 1000,
    criteria: rows,
  };
}
