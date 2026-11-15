#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Synthetic geometry-dense IFC generator (#10264). Public, no input model.
 *
 * Writes one STEP/IFC file of N unique IfcBuildingElementProxy elements, each
 * carrying one closed ellipsoid mesh of `rings x segs` quads
 * (2*segs*(rings-1) triangles), as either
 *
 *   --kind tfs   IFC4 IfcTriangulatedFaceSet: few entities, many triangles
 *                per MB. Reproduces the mid-stream kill driven by geometry the
 *                viewer's main thread keeps (#10264 mode B).
 *   --kind brep  IFC2X3 IfcFacetedBrep (point / loop / bound / face per
 *                triangle): many entities, few triangles per MB, the shape of
 *                large faceted-brep exports. Reproduces the kill before any
 *                geometry streams (#10264 mode A).
 *
 * Every element gets its own seeded per-vertex jitter, radii and placement, so
 * no instancing or dedup can collapse the geometry. Output is a pure function
 * of the arguments (seeded PRNG, fixed header timestamp): the same arguments
 * give byte-identical files. Generated files are never committed.
 *
 * Usage:
 *   node scripts/perf/gen-dense-ifc.mjs OUT.ifc (--target-mb N | --elements N)
 *        [--kind tfs|brep] [--rings 24] [--segs 48] [--psets 0] [--seed 1]
 *        [--schema IFC4|IFC2X3] [--grid 3]
 * Prints one JSON line: elements, triangles, entities, bytes, per-MB rates.
 */

import { closeSync, existsSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../lib/is-main-entry.mjs';

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
const MASK128 = (1n << 128n) - 1n;

/** 22-character IFC GlobalId, unique per integer n (first char 0..3). */
export function guid(n) {
  const v = (BigInt(n) * 0x9E3779B97F4A7C15F39CC0605CEDC835n + 0x1234567n) & MASK128;
  let out = B64[Number((v >> 126n) & 3n)];
  for (let i = 1; i < 22; i++) out += B64[Number((v >> BigInt(6 * (21 - i))) & 63n)];
  return out;
}

/** mulberry32: small, fast, seeded; identical sequence on every platform. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Compact STEP real with 3 decimals; STEP requires the '.'. */
export function real(x) {
  let s = x.toFixed(3);
  if (s.includes('.')) s = s.replace(/0+$/, '');
  if (s === '-0.') return '0.';
  return s.endsWith('.') ? `${s}0` : s;
}

/** Closed UV ellipsoid: 2 poles + (rings-1) latitude rings of `segs` vertices. */
export function ellipsoid(rand, rings, segs, rx, ry, rz, jitter) {
  const pts = [[0, 0, rz]];
  for (let i = 1; i < rings; i++) {
    const th = Math.PI * i / rings, st = Math.sin(th), ct = Math.cos(th);
    for (let j = 0; j < segs; j++) {
      const ph = 2 * Math.PI * j / segs, k = 1 + jitter * (rand() - 0.5);
      pts.push([rx * st * Math.cos(ph) * k, ry * st * Math.sin(ph) * k, rz * ct * k]);
    }
  }
  pts.push([0, 0, -rz]);
  const bot = pts.length - 1, ring = (i, j) => 1 + (i - 1) * segs + (j % segs), tris = [];
  for (let j = 0; j < segs; j++) tris.push([0, ring(1, j), ring(1, j + 1)]);
  for (let i = 1; i < rings - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = ring(i, j), b = ring(i, j + 1), c = ring(i + 1, j), d = ring(i + 1, j + 1);
      tris.push([a, c, d], [a, d, b]);
    }
  }
  for (let j = 0; j < segs; j++) tris.push([bot, ring(rings - 1, j + 1), ring(rings - 1, j)]);
  return { pts, tris };
}

/** Schemas the generator can write; both kinds are checked against this before anything runs. */
export const SCHEMAS = Object.freeze(['IFC4', 'IFC2X3']);

export const DEFAULTS = Object.freeze({ kind: 'tfs', rings: 24, segs: 48, psets: 0, seed: 1, grid: 3 });

/**
 * Stream the file through `sink(text)`. Stops after `elements` elements, or
 * once the output reaches `targetBytes`. Returns counts.
 */
export function generateDenseIfc(sink, options) {
  const o = { ...DEFAULTS, ...options };
  const schema = o.schema ?? (o.kind === 'tfs' ? 'IFC4' : 'IFC2X3');
  if (!['tfs', 'brep'].includes(o.kind)) throw new Error(`unknown kind ${o.kind}`);
  if (!SCHEMAS.includes(schema)) throw new Error(`unsupported schema ${schema}: use ${SCHEMAS.join(' or ')}`);
  if (o.kind === 'tfs' && schema !== 'IFC4') throw new Error('IfcTriangulatedFaceSet needs IFC4');
  if (!(o.elements > 0) && !(o.targetBytes > 0)) throw new Error('elements or targetBytes required');
  const int = (k, min) => { if (!Number.isInteger(o[k]) || o[k] < min) throw new Error(`${k} must be an integer >= ${min}, got ${o[k]}`); };
  int('rings', 2); int('segs', 3); int('psets', 0); int('seed', 0);
  if (o.elements !== undefined) int('elements', 0);
  if (o.targetBytes !== undefined && !(Number.isFinite(o.targetBytes) && o.targetBytes > 0)) throw new Error(`targetBytes must be a positive number, got ${o.targetBytes}`);
  if (!(Number.isFinite(o.grid) && o.grid > 0)) throw new Error(`grid must be a positive number, got ${o.grid}`);
  const rand = prng(o.seed);
  let id = 0, bytes = 0, g = 0;
  const raw = (s) => { bytes += s.length; sink(s); };
  const rec = (body) => { raw(`#${++id}=${body};\n`); return id; };
  const gid = () => guid(++g);

  raw(`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');\n`
    + `FILE_NAME('synthetic-dense.ifc','2026-11-15T00:00:00',('ifc-lite'),('ifc-lite'),'gen-dense-ifc','gen-dense-ifc','');\n`
    + `FILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n`);
  const person = rec("IFCPERSON($,$,'synthetic',$,$,$,$,$)");
  const org = rec("IFCORGANIZATION($,'synthetic',$,$,$)");
  const po = rec(`IFCPERSONANDORGANIZATION(#${person},#${org},$)`);
  const app = rec(`IFCAPPLICATION(#${org},'1','gen-dense-ifc','gen-dense-ifc')`);
  const oh = rec(`IFCOWNERHISTORY(#${po},#${app},$,.NOCHANGE.,$,$,$,0)`);
  const origin = rec('IFCCARTESIANPOINT((0.,0.,0.))');
  const zdir = rec('IFCDIRECTION((0.,0.,1.))');
  const xdir = rec('IFCDIRECTION((1.,0.,0.))');
  const ax = rec(`IFCAXIS2PLACEMENT3D(#${origin},#${zdir},#${xdir})`);
  const ctx = rec(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${ax},$)`);
  const body = rec(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${ctx},$,.MODEL_VIEW.,$)`);
  const lu = rec('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
  const au = rec('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)');
  const units = rec(`IFCUNITASSIGNMENT((#${lu},#${au}))`);
  const proj = rec(`IFCPROJECT('${gid()}',#${oh},'synthetic-dense',$,$,$,$,(#${ctx}),#${units})`);
  const sp = rec(`IFCLOCALPLACEMENT($,#${ax})`);
  const site = rec(`IFCSITE('${gid()}',#${oh},'Site',$,$,#${sp},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bp = rec(`IFCLOCALPLACEMENT(#${sp},#${ax})`);
  const bldg = rec(`IFCBUILDING('${gid()}',#${oh},'Building',$,$,#${bp},$,$,.ELEMENT.,$,$,$)`);
  const stp = rec(`IFCLOCALPLACEMENT(#${bp},#${ax})`);
  const storey = rec(`IFCBUILDINGSTOREY('${gid()}',#${oh},'Level 0',$,$,#${stp},$,$,.ELEMENT.,0.)`);
  rec(`IFCRELAGGREGATES('${gid()}',#${oh},$,$,#${proj},(#${site}))`);
  rec(`IFCRELAGGREGATES('${gid()}',#${oh},$,$,#${site},(#${bldg}))`);
  rec(`IFCRELAGGREGATES('${gid()}',#${oh},$,$,#${bldg},(#${storey}))`);

  const contain = (els) => rec(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${gid()}',#${oh},$,$,(${els.map((e) => `#${e}`).join(',')}),#${storey})`);
  let pending = [], n = 0, triangles = 0;
  for (;;) {
    if (o.elements > 0 && n >= o.elements) break;
    if (o.targetBytes > 0 && bytes >= o.targetBytes) break;
    const loc = rec(`IFCCARTESIANPOINT((${real((n % 1000) * o.grid)},${real(Math.floor(n / 1000) * o.grid)},0.))`);
    const eax = rec(`IFCAXIS2PLACEMENT3D(#${loc},$,$)`);
    const epl = rec(`IFCLOCALPLACEMENT(#${stp},#${eax})`);
    const rx = 0.6 + 0.6 * rand(), ry = 0.6 + 0.6 * rand(), rz = 0.8 + 0.8 * rand();
    const { pts, tris } = ellipsoid(rand, o.rings, o.segs, rx, ry, rz, 0.04);
    triangles += tris.length;
    let item, rtype;
    if (o.kind === 'tfs') {
      const pl = rec(`IFCCARTESIANPOINTLIST3D((${pts.map(([x, y, z]) => `(${real(x)},${real(y)},${real(z)})`).join(',')}))`);
      item = rec(`IFCTRIANGULATEDFACESET(#${pl},$,.T.,(${tris.map(([i, j, k]) => `(${i + 1},${j + 1},${k + 1})`).join(',')}),$)`);
      rtype = 'Tessellation';
    } else {
      const pid = pts.map(([x, y, z]) => rec(`IFCCARTESIANPOINT((${real(x)},${real(y)},${real(z)}))`));
      const faces = tris.map(([i, j, k]) => {
        const loop = rec(`IFCPOLYLOOP((#${pid[i]},#${pid[j]},#${pid[k]}))`);
        const bnd = rec(`IFCFACEOUTERBOUND(#${loop},.T.)`);
        return rec(`IFCFACE((#${bnd}))`);
      });
      const shell = rec(`IFCCLOSEDSHELL((${faces.map((f) => `#${f}`).join(',')}))`);
      item = rec(`IFCFACETEDBREP(#${shell})`);
      rtype = 'Brep';
    }
    const rep = rec(`IFCSHAPEREPRESENTATION(#${body},'Body','${rtype}',(#${item}))`);
    const pds = rec(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
    const el = rec(`IFCBUILDINGELEMENTPROXY('${gid()}',#${oh},'E${n}',$,$,#${epl},#${pds},$,.ELEMENT.)`);
    for (let p = 0; p < o.psets; p++) {
      const val = rec(`IFCPROPERTYSINGLEVALUE('P${p}',$,IFCLABEL('v${n}-${p}'),$)`);
      const ps = rec(`IFCPROPERTYSET('${gid()}',#${oh},'Pset_Synthetic${p}',$,(#${val}))`);
      rec(`IFCRELDEFINESBYPROPERTIES('${gid()}',#${oh},$,$,(#${el}),#${ps})`);
    }
    pending.push(el);
    if (pending.length >= 5000) { contain(pending); pending = []; }
    n++;
  }
  if (pending.length) contain(pending);
  raw('ENDSEC;\nEND-ISO-10303-21;\n');
  const mb = bytes / 1e6;
  return { kind: o.kind, schema, rings: o.rings, segs: o.segs, psets: o.psets, seed: o.seed, elements: n, triangles,
    entities: id, bytes, trianglesPerMB: Math.round(triangles / mb), entitiesPerMB: Math.round(id / mb) };
}

/** Write to `out` through a 4 MiB buffer; rename into place when complete. */
export function writeDenseIfc(out, options) {
  if (existsSync(out) && statSync(out).isDirectory()) throw new Error(`${out} is a directory`);
  const tmp = `${out}.tmp`, fd = openSync(tmp, 'w');
  let buf = [], len = 0, open = true;
  const close = () => { if (open) { open = false; closeSync(fd); } };
  const flush = () => {
    if (!len) return;
    const bytes = Buffer.from(buf.join(''), 'latin1');
    // writeSync may write fewer bytes than asked (e.g. a filling disk); never drop the rest.
    for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off);
    buf = []; len = 0;
  };
  try {
    const stats = generateDenseIfc((s) => { buf.push(s); len += s.length; if (len >= 1 << 22) flush(); }, options);
    flush();
    close();
    renameSync(tmp, out);
    return { out, ...stats };
  } catch (err) {
    close();
    rmSync(tmp, { force: true });
    throw err;
  }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'target-mb': { type: 'string' }, elements: { type: 'string' }, kind: { type: 'string' },
      rings: { type: 'string' }, segs: { type: 'string' }, psets: { type: 'string' },
      seed: { type: 'string' }, schema: { type: 'string' }, grid: { type: 'string' },
    },
  });
  // Plain decimal strings only: Number('') is 0 and Number('0x4') is 4, both silently wrong.
  const bad = [...['elements', 'rings', 'segs', 'psets', 'seed'].filter((k) => values[k] !== undefined && !/^\d+$/.test(values[k])),
    ...['target-mb', 'grid'].filter((k) => values[k] !== undefined && !/^\d+(\.\d+)?$/.test(values[k]))];
  if (bad.length) { console.error(`gen-dense-ifc: not a plain non-negative number: ${bad.map((k) => `--${k} '${values[k]}'`).join(', ')}`); process.exit(2); }
  if (values.schema !== undefined && !SCHEMAS.includes(values.schema)) { console.error(`gen-dense-ifc: unsupported --schema '${values.schema}': use ${SCHEMAS.join(' or ')}`); process.exit(2); }
  const out = positionals[0];
  if (!out || (!values['target-mb'] && !values.elements)) {
    console.error('usage: gen-dense-ifc.mjs OUT.ifc (--target-mb N | --elements N) [--kind tfs|brep] [--rings 24] [--segs 48] [--psets 0] [--seed 1] [--schema IFC4|IFC2X3] [--grid 3]');
    process.exit(2);
  }
  const num = (k) => (values[k] === undefined ? undefined : Number(values[k]));
  const t0 = Date.now();
  const stats = writeDenseIfc(out, {
    targetBytes: values['target-mb'] ? Math.round(Number(values['target-mb']) * 1e6) : undefined,
    elements: num('elements'), kind: values.kind ?? DEFAULTS.kind, rings: num('rings') ?? DEFAULTS.rings,
    segs: num('segs') ?? DEFAULTS.segs, psets: num('psets') ?? DEFAULTS.psets, seed: num('seed') ?? DEFAULTS.seed,
    schema: values.schema, grid: num('grid') ?? DEFAULTS.grid,
  });
  console.log(JSON.stringify({ ...stats, genSeconds: (Date.now() - t0) / 1000 }));
}

if (isMainEntry(import.meta.url)) main();
