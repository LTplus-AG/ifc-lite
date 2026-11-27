/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scenario families and the tier ladder of the huge-geometry stress harness
 * (scripts/perf/huge-geometry.md). A family is a list of weighted parts plus a
 * layout and a federation count; a tier is a nominal element count. The
 * resolved scenario (`resolveScenario`) is the complete, JSON-stable input of
 * the generator, recorded in every manifest and run result.
 *
 * `look: 'showcase'` resolves to the showcase city instead (huge-geometry-showcase.mjs):
 * footage only, labelled as such, never part of FAMILIES or a measured ladder.
 */

import { SHAPES } from './huge-geometry-shapes.mjs';
import { resolveShowcase } from './huge-geometry-showcase.mjs';

/** Nominal element counts, smallest first. The runner climbs until a tier fails. */
export const TIERS = Object.freeze([10_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 4_000_000]);

const part = (share, shape, cls, predefined, extra = {}) => ({ share, shape, cls, predefined, tris: 0, repeat: 0, prototypes: 16, openings: 0, ...extra });

const MIXED_PARTS = [
  part(0.35, 'box', 'IFCSLAB', 'FLOOR'),
  part(0.15, 'cylinder', 'IFCCOLUMN', 'COLUMN'),
  part(0.10, 'voided', 'IFCWALL', 'STANDARD', { openings: 1 }),
  part(0.30, 'mesh', 'IFCFURNITURE', 'NOTDEFINED', { tris: 300, repeat: 1, prototypes: 32 }),
  part(0.10, 'mesh', 'IFCBUILDINGELEMENTPROXY', 'ELEMENT', { tris: 200 }),
];

/**
 * `divisor` scales the tier down for families whose elements are heavy, so a
 * tier stays comparable in triangle volume rather than element count.
 */
export const FAMILIES = Object.freeze({
  'small-repeated': { about: 'many small identical meshes via IfcMappedItem (16 prototypes): instancing wins',
    layout: 'tower', models: 1, divisor: 1, parts: [part(1, 'mesh', 'IFCFURNITURE', 'NOTDEFINED', { tris: 48, repeat: 1 })] },
  'small-unique': { about: 'many small unique meshes with seeded jitter: instancing and dedup defeated',
    layout: 'tower', models: 1, divisor: 1, parts: [part(1, 'mesh', 'IFCBUILDINGELEMENTPROXY', 'ELEMENT', { tris: 48 })] },
  'dense-few': { about: 'tier/50 unique ellipsoids of ~5k triangles each: triangle-bound',
    layout: 'tower', models: 1, divisor: 50, parts: [part(1, 'mesh', 'IFCBUILDINGELEMENTPROXY', 'ELEMENT', { tris: 5000 })] },
  mixed: { about: 'realistic mix: slabs, round columns, voided walls (CSG), instanced furniture, unique proxies',
    layout: 'tower', models: 1, divisor: 1, parts: MIXED_PARTS },
  'mixed-campus': { about: 'the mixed parts spread over a ~2 km campus of 2,000-element buildings: culling-bound',
    layout: 'campus', models: 1, divisor: 1, parts: MIXED_PARTS },
  'mixed-fed4': { about: 'the mixed parts federated into 4 models loaded together',
    layout: 'tower', models: 4, divisor: 1, parts: MIXED_PARTS },
});

/** Compact tier label: 10k, 250k, 1M, 2M. */
export function tierLabel(n) {
  if (n >= 1e6 && n % 1e6 === 0) return `${n / 1e6}M`;
  if (n >= 1e3 && n % 1e3 === 0) return `${n / 1e3}k`;
  return String(n);
}

/**
 * Resolve CLI/ladder options into the complete generator input. `elements` is
 * the nominal tier; the family divisor applies. Overrides: layout, models,
 * repeat (all parts), tris (all mesh parts), seed, name.
 */
export function resolveScenario(o) {
  // The showcase look (footage only) is not a family: it has its own generator and never enters FAMILIES or the ladder.
  if (o.look !== undefined && o.look !== 'measurement') {
    if (o.look !== 'showcase') throw new Error(`unknown look '${o.look}': use showcase (or omit --look)`);
    return resolveShowcase(o);
  }
  const family = FAMILIES[o.scenario];
  if (!family) throw new Error(`unknown scenario '${o.scenario}': use ${Object.keys(FAMILIES).join(', ')}`);
  const nominal = o.elements;
  if (!Number.isInteger(nominal) || nominal < 1) throw new Error(`elements must be a positive integer, got ${nominal}`);
  const layout = o.layout ?? family.layout;
  if (!['tower', 'campus'].includes(layout)) throw new Error(`layout must be tower or campus, got ${layout}`);
  const models = o.models ?? family.models;
  if (!Number.isInteger(models) || models < 1 || models > 64) throw new Error(`models must be an integer in 1..64, got ${models}`);
  if (o.repeat !== undefined && !(o.repeat >= 0 && o.repeat <= 1)) throw new Error(`repeat must be in [0, 1], got ${o.repeat}`);
  if (o.tris !== undefined && !(Number.isInteger(o.tris) && o.tris >= 24)) throw new Error(`tris must be an integer >= 24, got ${o.tris}`);
  const seed = o.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`seed must be a non-negative integer, got ${seed}`);
  const elements = Math.max(1, Math.round(nominal / family.divisor));
  if (elements < models) throw new Error(`${elements} elements cannot fill ${models} models`);
  const parts = family.parts.map((p) => {
    if (!SHAPES.includes(p.shape)) throw new Error(`unknown shape ${p.shape}`);
    return { ...p, ...(o.repeat !== undefined ? { repeat: o.repeat } : {}), ...(o.tris !== undefined && p.shape === 'mesh' ? { tris: o.tris } : {}) };
  });
  const total = parts.reduce((acc, p) => acc + p.share, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error(`part shares of ${o.scenario} sum to ${total}, not 1`);
  const overrides = [o.layout && o.layout !== family.layout ? o.layout : '', o.models && o.models !== family.models ? `fed${models}` : '',
    o.repeat !== undefined ? `r${o.repeat}` : '', o.tris !== undefined ? `t${o.tris}` : '', seed !== 1 ? `s${seed}` : ''].filter(Boolean);
  const name = o.name ?? [o.scenario, tierLabel(nominal), ...overrides].join('-');
  if (!/^[\w.-]+$/.test(name)) throw new Error(`name must be [A-Za-z0-9_.-], got ${name}`);
  return { name, scenario: o.scenario, nominal, elements, layout, models, seed, parts };
}

/** The ladder for `scenarios` x `tiers`, in climbing order per scenario. */
export function planLadder(scenarios = Object.keys(FAMILIES), tiers = TIERS, overrides = {}) {
  return scenarios.map((scenario) => ({ scenario, steps: tiers.map((elements) => resolveScenario({ ...overrides, scenario, elements })) }));
}
