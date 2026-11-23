#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Synthetic huge-geometry IFC generator for the viewer stress harness
 * (see scripts/perf/huge-geometry.md). Public, no input model.
 *
 * A model is `elements` IFC4 elements drawn from a scenario's weighted parts
 * (huge-geometry-ladder.mjs). Each part fixes a shape (box, cylinder, mesh,
 * voided wall), a triangle target for meshes, an IFC class and a `repeat`
 * share: that fraction of its elements reference one of `prototypes`
 * IfcRepresentationMaps through IfcMappedItem (exercises instancing), the
 * rest carry their own seeded geometry (defeats it).
 *
 * Layout `tower` packs elements into a compact block (3 m grid, 3.5 m floors);
 * `campus` spreads 2,000-element buildings over a jittered 80 m grid, so 1M
 * elements span about 1.8 km and frustum/contribution culling matter.
 * `models > 1` slices the same element sequence into contiguous federated
 * files: every element's geometry depends only on (seed, global index), so the
 * union of a federated set equals the single-file model element for element.
 *
 * Output is a pure function of the arguments: same arguments, same bytes.
 * Generated files are never committed.
 *
 * `--look showcase` writes the footage-only showcase city instead
 * (huge-geometry-showcase.mjs); it is never a measurement family.
 *
 * Usage:
 *   node scripts/perf/huge-geometry-gen.mjs --look showcase --elements 1000000 --out DIR [--seed 1]
 *   node scripts/perf/huge-geometry-gen.mjs --scenario mixed --elements 100000 --out DIR
 *        [--layout tower|campus] [--models 1] [--repeat 0..1] [--tris N] [--seed 1] [--name NAME]
 * Writes DIR/NAME[-mK].ifc and DIR/NAME.json (parameters + per-file stats);
 * prints the manifest as one JSON line.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { guid, prng } from './gen-dense-ifc.mjs';
import { mix, placement, shapeTriangles, writeItem, writeMappedShape, writeOpenings, writeProductShape, writePrototype, writeShared } from './huge-geometry-shapes.mjs';
import { resolveScenario } from './huge-geometry-ladder.mjs';
import { generateShowcaseModel } from './huge-geometry-showcase.mjs';

const GOLDEN = 0.6180339887498949;
const SILVER = 0.4142135623730951;
const PALETTE = [[0.78, 0.76, 0.72], [0.55, 0.62, 0.70], [0.82, 0.55, 0.38], [0.45, 0.62, 0.45], [0.86, 0.80, 0.52],
  [0.62, 0.50, 0.70], [0.40, 0.55, 0.62], [0.70, 0.42, 0.42]];
export const CELL = 3;
export const FLOOR = 3.5;
export const CAMPUS = Object.freeze({ perBuilding: 2000, side: 10, pitch: 80, jitter: 15 });

/** Part index of global element `i`: low-discrepancy, so parts interleave evenly in space. */
export function partOf(parts, i) {
  const u = (i * GOLDEN) % 1;
  let acc = 0;
  for (let k = 0; k < parts.length; k++) { acc += parts[k].share; if (u < acc) return k; }
  return parts.length - 1;
}

/** Whether element `i` of a part with `repeat` share references a prototype. */
export const isRepeated = (repeat, i) => repeat >= 1 || (repeat > 0 && ((i * SILVER) % 1) < repeat);

/** Tower block dimensions for `n` elements: about cbrt(n)/2 floors of a square footprint. */
export function towerDims(n) {
  const floors = Math.min(200, Math.max(1, Math.round(Math.cbrt(n) / 2)));
  return { floors, side: Math.max(1, Math.ceil(Math.sqrt(n / floors))) };
}

/** World position (x, y), storey index and storey count of global element `i` of `n`. */
export function layoutOf(layout, n, i, seed) {
  if (layout === 'tower') {
    const { floors, side } = towerDims(n);
    const per = side * side, f = Math.floor(i / per), r = i % per;
    return { x: (r % side) * CELL, y: Math.floor(r / side) * CELL, storey: f, storeys: floors };
  }
  if (layout === 'campus') {
    const { perBuilding, side, pitch, jitter } = CAMPUS;
    const buildings = Math.ceil(n / perBuilding), grid = Math.ceil(Math.sqrt(buildings));
    const b = Math.floor(i / perBuilding), r = i % perBuilding, per = side * side;
    const j = prng(mix(seed, 0x0B0B, b));
    const bx = (b % grid) * pitch + (j() - 0.5) * 2 * jitter, by = Math.floor(b / grid) * pitch + (j() - 0.5) * 2 * jitter;
    const floors = Math.ceil(perBuilding / per);
    return { x: bx + (r % side) * CELL, y: by + (Math.floor(r / side) % side) * CELL, storey: Math.floor(r / per), storeys: floors };
  }
  throw new Error(`unknown layout ${layout}`);
}

/** Contiguous [start, end) global index range of federated model `m` of `models`. */
export function modelRange(n, models, m) {
  return [Math.floor((n * m) / models), Math.floor((n * (m + 1)) / models)];
}

/**
 * Stream federated model `m` of the resolved scenario `s` through `sink(text)`.
 * Returns counts: elements, per-part elements and repeated elements, openings,
 * entities, bytes, exact triangles where the shape fixes them.
 */
export function generateHugeModel(sink, s, m = 0) {
  const [start, end] = modelRange(s.elements, s.models, m);
  let id = 0, bytes = 0, g = 0;
  const raw = (text) => { bytes += text.length; sink(text); };
  const rec = (body) => { raw(`#${++id}=${body};\n`); return id; };
  // GlobalIds stay unique across a federated set: each model gets its own 2^40 range.
  const gid = () => guid((m + 1) * 2 ** 40 + ++g);
  raw(`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');\n`
    + `FILE_NAME('${s.name}-m${m}.ifc','2026-11-22T00:00:00',('ifc-lite'),('ifc-lite'),'huge-geometry-gen','huge-geometry-gen','');\n`
    + `FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n`);
  const person = rec("IFCPERSON($,$,'synthetic',$,$,$,$,$)");
  const org = rec("IFCORGANIZATION($,'synthetic',$,$,$)");
  const po = rec(`IFCPERSONANDORGANIZATION(#${person},#${org},$)`);
  const app = rec(`IFCAPPLICATION(#${org},'1','huge-geometry-gen','huge-geometry-gen')`);
  const oh = rec(`IFCOWNERHISTORY(#${po},#${app},$,.NOCHANGE.,$,$,$,0)`);
  const shared = writeShared(rec, PALETTE);
  const w = { rec, shared };
  const lu = rec('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
  const au = rec('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)');
  const units = rec(`IFCUNITASSIGNMENT((#${lu},#${au}))`);
  const proj = rec(`IFCPROJECT('${gid()}',#${oh},'${s.name} m${m}',$,$,$,$,(#${shared.ctx}),#${units})`);
  const sp = rec(`IFCLOCALPLACEMENT($,#${shared.ax})`);
  const site = rec(`IFCSITE('${gid()}',#${oh},'Site',$,$,#${sp},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bp = rec(`IFCLOCALPLACEMENT(#${sp},#${shared.ax})`);
  const bldg = rec(`IFCBUILDING('${gid()}',#${oh},'Building ${m}',$,$,#${bp},$,$,.ELEMENT.,$,$,$)`);
  rec(`IFCRELAGGREGATES('${gid()}',#${oh},$,$,#${proj},(#${site}))`);
  rec(`IFCRELAGGREGATES('${gid()}',#${oh},$,$,#${site},(#${bldg}))`);

  // Prototypes per part with a repeat share, each from its own (seed, part, j) stream.
  const maps = s.parts.map((part, k) => (part.repeat > 0
    ? Array.from({ length: part.prototypes }, (_, j) => writePrototype(w, part, prng(mix(s.seed, 0x5000 + k, j)), k % PALETTE.length))
    : null));

  const storeys = new Map(); // storey index -> { id, placement, pending[] }
  const storeyOf = (f) => {
    let st = storeys.get(f);
    if (!st) {
      const pl = placement(rec, bp, 0, 0, f * FLOOR);
      st = { id: rec(`IFCBUILDINGSTOREY('${gid()}',#${oh},'Level ${f}',$,$,#${pl},$,$,.ELEMENT.,${(f * FLOOR).toFixed(1)})`), placement: pl, pending: [] };
      storeys.set(f, st);
    }
    return st;
  };
  const contain = (st) => {
    rec(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${gid()}',#${oh},$,$,(${st.pending.map((e) => `#${e}`).join(',')}),#${st.id})`);
    st.pending = [];
  };

  const perPart = s.parts.map(() => ({ elements: 0, repeated: 0 }));
  let triangles = 0, trianglesExact = true, openings = 0;
  const partTriangles = s.parts.map(shapeTriangles);
  for (let i = start; i < end; i++) {
    const k = partOf(s.parts, i), part = s.parts[k];
    const { x, y, storey } = layoutOf(s.layout, s.elements, i, s.seed);
    const st = storeyOf(storey);
    const rand = prng(mix(s.seed, i));
    const epl = placement(rec, st.placement, x, y, 0);
    const repeated = isRepeated(part.repeat, i);
    let pds;
    if (repeated) pds = writeMappedShape(w, maps[k][mix(s.seed, i, 7) % part.prototypes]);
    else {
      const { item, repType } = writeItem(w, part, rand);
      pds = writeProductShape(w, item, repType, k % PALETTE.length);
    }
    const tail = part.cls === 'IFCFURNISHINGELEMENT' ? '' : `,.${part.predefined}.`;
    const el = rec(`${part.cls}('${gid()}',#${oh},'E${i}',$,$,#${epl},#${pds},$${tail})`);
    if (part.shape === 'voided' && part.openings > 0) {
      writeOpenings(w, el, epl, part.openings, rand, gid, oh);
      openings += part.openings;
    }
    st.pending.push(el);
    if (st.pending.length >= 5000) contain(st);
    perPart[k].elements++;
    if (repeated) perPart[k].repeated++;
    const t = partTriangles[k];
    if (t === null) trianglesExact = false; else triangles += t;
  }
  const levels = [...storeys.keys()].sort((a, b) => a - b).map((f) => storeys.get(f));
  for (const st of levels) if (st.pending.length) contain(st);
  if (levels.length) rec(`IFCRELAGGREGATES('${gid()}',#${oh},$,$,#${bldg},(${levels.map((st) => `#${st.id}`).join(',')}))`);
  raw('ENDSEC;\nEND-ISO-10303-21;\n');
  return { model: m, elements: end - start, perPart, openings, storeys: levels.length, entities: id, bytes,
    triangles: trianglesExact ? triangles : null, trianglesKnown: triangles };
}

/** Write one model to `out` through a 4 MiB buffer; rename into place when complete. */
export function writeHugeModel(out, s, m) {
  if (existsSync(out) && statSync(out).isDirectory()) throw new Error(`${out} is a directory`);
  const tmp = `${out}.tmp`, fd = openSync(tmp, 'w');
  let buf = [], len = 0, open = true;
  const close = () => { if (open) { open = false; closeSync(fd); } };
  const flush = () => {
    if (!len) return;
    const bytes = Buffer.from(buf.join(''), 'latin1');
    for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off);
    buf = []; len = 0;
  };
  try {
    const generate = s.look === 'showcase' ? generateShowcaseModel : generateHugeModel;
    const stats = generate((text) => { buf.push(text); len += text.length; if (len >= 1 << 22) flush(); }, s, m);
    flush();
    close();
    renameSync(tmp, out);
    return { file: out, ...stats };
  } catch (err) {
    close();
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Generate every file of a scenario into `dir`; returns (and writes) the manifest. Reuses an identical existing set. */
export function generateScenario(dir, options) {
  const s = resolveScenario(options);
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, `${s.name}.json`);
  const files = Array.from({ length: s.models }, (_, m) => join(dir, s.models > 1 ? `${s.name}-m${m}.ifc` : `${s.name}.ifc`));
  if (existsSync(manifestPath) && files.every((f) => existsSync(f))) {
    try {
      const prev = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (JSON.stringify(prev.scenario) === JSON.stringify(s)) return { ...prev, reused: true };
    } catch (err) { console.warn(`huge-geometry-gen: ignoring unreadable manifest ${manifestPath}: ${err.message}`); }
  }
  const t0 = Date.now();
  const models = files.map((f, m) => writeHugeModel(f, s, m));
  const sum = (key) => models.reduce((acc, x) => acc + (x[key] ?? 0), 0);
  const manifest = { generator: 'huge-geometry-gen/1', scenario: s, files, models,
    totals: { elements: sum('elements'), openings: sum('openings'), entities: sum('entities'), bytes: sum('bytes'),
      triangles: models.every((x) => x.triangles !== null) ? sum('triangles') : null, trianglesKnown: sum('trianglesKnown') },
    genSeconds: (Date.now() - t0) / 1000 };
  if (s.look === 'showcase') {
    // Footage only: label it, and lift the recorder's showcase block (camera anchors, hero ids) out of the per-file stats.
    manifest.look = 'showcase';
    manifest.label = s.label;
    manifest.showcase = models[0].showcase;
    manifest.totals.repeated = models[0].repeated;
    manifest.totals.unique = models[0].unique;
    manifest.totals.perClass = models[0].perClass;
    delete models[0].showcase;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function main() {
  const { values } = parseArgs({ options: {
    scenario: { type: 'string' }, elements: { type: 'string' }, out: { type: 'string' }, layout: { type: 'string' },
    models: { type: 'string' }, repeat: { type: 'string' }, tris: { type: 'string' }, seed: { type: 'string' }, name: { type: 'string' },
    look: { type: 'string' },
  } });
  if ((!values.scenario && !values.look) || !values.elements || !values.out) {
    console.error('usage: huge-geometry-gen.mjs --scenario NAME --elements N --out DIR [--layout tower|campus] [--models 1] [--repeat 0..1] [--tris N] [--seed 1] [--name NAME]\n'
      + '       huge-geometry-gen.mjs --look showcase --elements N --out DIR [--seed 1] [--name NAME]   (footage-only city, not a measurement family)');
    process.exit(2);
  }
  const num = (k) => (values[k] === undefined ? undefined : Number(values[k]));
  try {
    const manifest = generateScenario(resolve(values.out), { scenario: values.scenario, elements: num('elements'), layout: values.layout,
      models: num('models'), repeat: num('repeat'), tris: num('tris'), seed: num('seed'), name: values.name, look: values.look });
    console.log(JSON.stringify({ name: manifest.scenario.name, files: manifest.files, totals: manifest.totals, genSeconds: manifest.genSeconds, reused: manifest.reused ?? false }));
  } catch (err) {
    console.error(`huge-geometry-gen: ${err.message}`);
    process.exit(2);
  }
}

if (isMainEntry(import.meta.url)) main();
