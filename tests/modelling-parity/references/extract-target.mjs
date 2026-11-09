#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Derive a machine-readable target spec from a reference IFC (lane L5, #9296).
//
// Usage:
//   node tests/modelling-parity/references/extract-target.mjs <ref-id> [--out FILE]
//   node tests/modelling-parity/references/extract-target.mjs <ref-id> --check   # fail if --out FILE differs
//
// <ref-id> is a key of manifest.json. The IFC is read from the cache that
// fetch-references.mjs fills (or from the repo fixture cache for refs whose
// bytes come from tests/models).
//
// Facts come from two independent readers, so a disagreement is visible:
//   1. A small zero-dependency STEP reader over the file text. It supplies
//      storeys, containment, wall axis lengths, door/window sizes, quantity
//      sets and space areas. It never executes anything from the file.
//   2. The @ifc-lite/wasm mesh pass. It supplies per-element extents and the
//      roof slope clusters, which have no data-level source.
//
// Requires a built CLI/wasm (`pnpm turbo build --filter=@ifc-lite/cli...`).

import { isMainEntry } from '../../../scripts/lib/is-main-entry.mjs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyPath } from './fetch-references.mjs';
import { HERE, ROOT, resolveReferencePath } from './lib.mjs';

// ---------------------------------------------------------------- STEP reader

/** Parse the DATA section into Map<id, {type, args}>. Typed values become {t, v}. */
export function parseStep(text) {
  const start = text.indexOf('DATA;');
  const body = start >= 0 ? text.slice(start + 5) : text;
  const entities = new Map();
  let i = 0;
  const n = body.length;

  const skipWs = () => {
    for (;;) {
      const c = body.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else if (c === 47 && body.charCodeAt(i + 1) === 42) {
        const e = body.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
      } else break;
    }
  };

  const parseValue = () => {
    skipWs();
    const c = body[i];
    if (c === '(') {
      i++;
      const list = [];
      skipWs();
      if (body[i] === ')') { i++; return list; }
      for (;;) {
        list.push(parseValue());
        skipWs();
        if (body[i] === ',') { i++; continue; }
        if (body[i] === ')') { i++; return list; }
        throw new Error(`STEP: unexpected '${body[i]}' near ${i}`);
      }
    }
    if (c === "'") {
      let j = i + 1;
      let s = '';
      for (;;) {
        const q = body.indexOf("'", j);
        if (q < 0) throw new Error('STEP: unterminated string');
        s += body.slice(j, q);
        if (body[q + 1] === "'") { s += "'"; j = q + 2; continue; }
        i = q + 1;
        return s;
      }
    }
    if (c === '#') {
      let j = i + 1;
      while (body.charCodeAt(j) >= 48 && body.charCodeAt(j) <= 57) j++;
      const id = Number(body.slice(i + 1, j));
      i = j;
      return { ref: id };
    }
    if (c === '$') { i++; return null; }
    if (c === '*') { i++; return '*'; }
    if (c === '.') {
      const e = body.indexOf('.', i + 1);
      const v = body.slice(i + 1, e);
      i = e + 1;
      return { en: v };
    }
    // number or typed value IFCLABEL('x')
    let j = i;
    while (j < n && !',()'.includes(body[j]) && body.charCodeAt(j) > 32) j++;
    const tok = body.slice(i, j);
    i = j;
    skipWs();
    if (body[i] === '(') {
      const list = parseValue();
      // IFCLABEL('x') carries one value: unwrap it so strVal/numVal can read it.
      return { t: tok, v: Array.isArray(list) && list.length === 1 ? list[0] : list };
    }
    const num = Number(tok);
    if (Number.isNaN(num)) throw new Error(`STEP: bad token '${tok}'`);
    return num;
  };

  for (;;) {
    skipWs();
    if (i >= n) break;
    if (body[i] !== '#') {
      const e = body.indexOf(';', i);
      if (e < 0) break;
      if (body.slice(i, e).trim().startsWith('ENDSEC')) { i = e + 1; continue; }
      i = e + 1;
      continue;
    }
    let j = i + 1;
    while (body.charCodeAt(j) >= 48 && body.charCodeAt(j) <= 57) j++;
    const id = Number(body.slice(i + 1, j));
    i = j;
    skipWs();
    if (body[i] !== '=') { const e = body.indexOf(';', i); i = e < 0 ? n : e + 1; continue; }
    i++;
    skipWs();
    j = i;
    while (j < n && body[j] !== '(' && body[j] !== ';') j++;
    const type = body.slice(i, j).trim().toUpperCase();
    i = j;
    if (body[i] === '(') {
      const args = parseValue();
      entities.set(id, { type, args });
    } else {
      // complex entity "( A() B() )" is not used by the references; skip
      entities.set(id, { type, args: [] });
    }
    const e = body.indexOf(';', i);
    i = e < 0 ? n : e + 1;
  }
  return entities;
}

// ------------------------------------------------------------------ helpers

const refId = (v) => (v && typeof v === 'object' && 'ref' in v ? v.ref : null);
const refList = (v) => (Array.isArray(v) ? v.map(refId).filter((x) => x !== null) : []);
// ISO 10303-21 string escapes: \X2\hhhh..\X0\ (UTF-16), \X\hh (Latin-1), \S\c (high-bit char).
const decodeStep = (str) => str
  .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, h) => (h.match(/.{4}/g) ?? []).map((c) => String.fromCharCode(parseInt(c, 16))).join(''))
  .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\S\\(.)/g, (_, c) => String.fromCharCode(c.charCodeAt(0) + 128));
const strVal = (v) => (typeof v === 'string' ? decodeStep(v) : v && typeof v === 'object' && 'v' in v ? strVal(v.v) : null);
const numVal = (v) => (typeof v === 'number' ? v : v && typeof v === 'object' && 'v' in v ? numVal(v.v) : null);
const enumVal = (v) => (v && typeof v === 'object' && 'en' in v ? v.en : null);
const round = (x, d = 3) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; // column-major 4x4

function mul(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
    r[c * 4 + rr] = s;
  }
  return r;
}
const apply = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const norm3 = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class Model {
  constructor(text) {
    this.e = parseStep(text);
    this.byType = new Map();
    for (const [id, ent] of this.e) {
      if (!this.byType.has(ent.type)) this.byType.set(ent.type, []);
      this.byType.get(ent.type).push(id);
    }
    this.placementCache = new Map();
    this.lengthScale = this.detectUnitScale('LENGTHUNIT', 1);
    this.areaScale = this.detectUnitScale('AREAUNIT', this.lengthScale ** 2);
    this.volumeScale = this.detectUnitScale('VOLUMEUNIT', this.lengthScale ** 3);
    this.schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(text.slice(0, 200000))?.[1] ?? null;
    this.header = text.slice(0, text.indexOf('DATA;') > 0 ? text.indexOf('DATA;') : 4000);
    this.buildRelations();
  }
  all(type) { return this.byType.get(type) ?? []; }
  get(id) { return this.e.get(id); }

  unitScale(id) {
    const seen = new Set();
    let factor = 1;
    for (;;) {
      if (seen.has(id)) throw new Error('Cyclic unit conversion');
      seen.add(id);
      const unit = this.get(id);
      if (unit?.type === 'IFCSIUNIT') {
        const power = { METRE: 1, SQUARE_METRE: 2, CUBIC_METRE: 3 }[enumVal(unit.args[3])];
        if (!power) throw new Error('Unsupported dimensional SI unit');
        const prefix = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: .1, CENTI: .01, MILLI: .001, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18 };
        return factor * (prefix[enumVal(unit.args[2])] ?? 1) ** power;
      }
      if (unit?.type !== 'IFCCONVERSIONBASEDUNIT') throw new Error('Unsupported dimensional unit');
      const measure = this.get(refId(unit.args[3]));
      const value = numVal(measure?.args[0]);
      if (value === null) throw new Error('Missing unit conversion factor');
      factor *= value;
      id = refId(measure?.args[1]);
    }
  }

  detectUnitScale(type, fallback) {
    const project = this.get(this.all('IFCPROJECT')[0]);
    const assignment = this.get(refId(project?.args[8]));
    const id = refList(assignment?.args[0] ?? []).find((id) => enumVal(this.get(id)?.args[1]) === type);
    return id === undefined ? fallback : this.unitScale(id);
  }

  buildRelations() {
    this.containedIn = new Map(); // element -> spatial container id
    for (const id of this.all('IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
      const a = this.get(id).args;
      for (const el of refList(a[4])) this.containedIn.set(el, refId(a[5]));
    }
    this.parentOf = new Map(); // part -> aggregate
    this.partsOf = new Map();
    for (const id of this.all('IFCRELAGGREGATES')) {
      const a = this.get(id).args;
      const parent = refId(a[4]);
      for (const c of refList(a[5])) this.parentOf.set(c, parent);
      this.partsOf.set(parent, [...(this.partsOf.get(parent) ?? []), ...refList(a[5])]);
    }
    this.voidsOf = new Map(); // opening -> host
    for (const id of this.all('IFCRELVOIDSELEMENT')) {
      const a = this.get(id).args;
      this.voidsOf.set(refId(a[5]), refId(a[4]));
    }
    this.fillsOf = new Map(); // opening -> filling element
    for (const id of this.all('IFCRELFILLSELEMENT')) {
      const a = this.get(id).args;
      this.fillsOf.set(refId(a[4]), refId(a[5]));
    }
    this.hostOfFill = new Map(); // door/window -> wall
    for (const [opening, fill] of this.fillsOf) this.hostOfFill.set(fill, this.voidsOf.get(opening) ?? null);
    this.definedBy = new Map(); // object -> [pset/qto ids]
    for (const id of this.all('IFCRELDEFINESBYPROPERTIES')) {
      const a = this.get(id).args;
      const def = refId(a[5]);
      for (const o of refList(a[4])) this.definedBy.set(o, [...(this.definedBy.get(o) ?? []), def]);
    }
  }

  /** World placement matrix of an IfcLocalPlacement (project length units). */
  placement(id) {
    if (id === null || id === undefined) return IDENT;
    if (this.placementCache.has(id)) return this.placementCache.get(id);
    const ent = this.get(id);
    let m = IDENT;
    if (ent?.type === 'IFCLOCALPLACEMENT') {
      const parent = this.placement(refId(ent.args[0]));
      m = mul(parent, this.axis2(refId(ent.args[1])));
    }
    this.placementCache.set(id, m);
    return m;
  }

  axis2(id) {
    const ent = this.get(id);
    if (!ent) return IDENT;
    if (ent.type === 'IFCAXIS2PLACEMENT2D') {
      const loc = this.get(refId(ent.args[0]))?.args[0] ?? [0, 0];
      const rd = refId(ent.args[1]) ? this.get(refId(ent.args[1])).args[0] : [1, 0];
      const x = norm3([rd[0], rd[1], 0]);
      const z = [0, 0, 1];
      const y = cross(z, x);
      return [...x, 0, ...y, 0, ...z, 0, loc[0], loc[1], 0, 1];
    }
    const loc = this.get(refId(ent.args[0]))?.args[0] ?? [0, 0, 0];
    const L = [loc[0] ?? 0, loc[1] ?? 0, loc[2] ?? 0];
    const zArg = refId(ent.args[1]) ? this.get(refId(ent.args[1])).args[0] : [0, 0, 1];
    const xArg = refId(ent.args[2]) ? this.get(refId(ent.args[2])).args[0] : [1, 0, 0];
    const z = norm3([zArg[0] ?? 0, zArg[1] ?? 0, zArg[2] ?? 0]);
    let x = norm3([xArg[0] ?? 0, xArg[1] ?? 0, xArg[2] ?? 0]);
    const d = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
    x = norm3([x[0] - d * z[0], x[1] - d * z[1], x[2] - d * z[2]]);
    const y = cross(z, x);
    return [...x, 0, ...y, 0, ...z, 0, ...L, 1];
  }

  name(id) { return strVal(this.get(id)?.args[2]); }
  globalId(id) { return strVal(this.get(id)?.args[0]); }

  /** Nearest spatial storey for an element: direct containment, then aggregate parent, then host wall. */
  storeyOf(id, seen = new Set()) {
    if (seen.has(id)) return null;
    seen.add(id);
    const c = this.containedIn.get(id);
    if (c && this.get(c)?.type === 'IFCBUILDINGSTOREY') return c;
    const p = this.parentOf.get(id);
    if (p) {
      if (this.get(p)?.type === 'IFCBUILDINGSTOREY') return p;
      const r = this.storeyOf(p, seen);
      if (r) return r;
    }
    const host = this.hostOfFill.get(id);
    if (host) return this.storeyOf(host, seen);
    return null;
  }

  /** Flat property map for one element: { 'Pset.Prop': value } plus quantities. */
  props(id) {
    const out = {};
    for (const def of this.definedBy.get(id) ?? []) {
      const d = this.get(def);
      if (!d) continue;
      if (d.type === 'IFCPROPERTYSET') {
        const setName = strVal(d.args[2]);
        for (const pid of refList(d.args[4])) {
          const p = this.get(pid);
          if (p?.type === 'IFCPROPERTYSINGLEVALUE') {
            const n = numVal(p.args[2]);
            const dimensional = { IFCAREAMEASURE: this.areaScale, IFCLENGTHMEASURE: this.lengthScale, IFCVOLUMEMEASURE: this.volumeScale }[p.args[2]?.t];
            const scale = p.args[3] ? this.unitScale(refId(p.args[3])) : dimensional ?? 1;
            out[`${setName}.${strVal(p.args[0])}`] = n === null ? strVal(p.args[2]) ?? enumVal(p.args[2]?.v) : n * scale;
          }
        }
      } else if (d.type === 'IFCELEMENTQUANTITY') {
        const setName = strVal(d.args[2]);
        for (const qid of refList(d.args[5])) {
          const q = this.get(qid);
          if (!q) continue;
          const v = numVal(q.args[3]);
          const projectScale = q.type === 'IFCQUANTITYLENGTH' ? this.lengthScale : q.type === 'IFCQUANTITYAREA' ? this.areaScale : q.type === 'IFCQUANTITYVOLUME' ? this.volumeScale : 1;
          const scale = q.args[2] ? this.unitScale(refId(q.args[2])) : projectScale;
          out[`${setName}.${strVal(q.args[0])}`] = v === null ? null : v * scale;
        }
      }
    }
    return out;
  }

  /** Axis polyline of a product in world metres, or null. */
  axisPoints(id) {
    const ent = this.get(id);
    const pds = this.get(refId(ent?.args[6]));
    if (!pds || pds.type !== 'IFCPRODUCTDEFINITIONSHAPE') return null;
    const m = this.placement(refId(ent.args[5]));
    for (const rid of refList(pds.args[2])) {
      const rep = this.get(rid);
      if (rep?.type !== 'IFCSHAPEREPRESENTATION' || strVal(rep.args[1]) !== 'Axis') continue;
      for (const item of refList(rep.args[3])) {
        const it = this.get(item);
        if (it?.type !== 'IFCPOLYLINE') continue;
        const pts = refList(it.args[0]).map((p) => {
          const c = this.get(p).args[0];
          return apply(m, [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]).map((x) => x * this.lengthScale);
        });
        if (pts.length >= 2) return pts;
      }
    }
    return null;
  }

  worldOrigin(id) {
    const m = this.placement(refId(this.get(id)?.args[5]));
    return [m[12] * this.lengthScale, m[13] * this.lengthScale, m[14] * this.lengthScale];
  }
}

// ------------------------------------------------------------- wasm mesh pass

async function meshPass(bytes, wantedIds) {
  // The wasm runtime logs to console.log/info; keep stdout for the JSON result.
  const saved = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = console.warn = () => {};
  try { return await meshPassInner(bytes, wantedIds); } finally { Object.assign(console, saved); }
}

async function meshPassInner(bytes, wantedIds) {
  const require = createRequire(resolve(ROOT, 'packages/cli/package.json'));
  const wasmPath = require.resolve('@ifc-lite/wasm/ifc-lite_bg.wasm');
  const wasm = await import(require.resolve('@ifc-lite/wasm'));
  wasm.initSync({ module: readFileSync(wasmPath) });
  const api = new wasm.IfcAPI();
  const extents = new Map(); // id -> {min,max} in IFC world axes (Z-up) shift-free extents only
  const tris = new Map(); // id -> [{n:[x,y,z] (IFC Z-up), a}] for wanted ids
  try {
    api.setComputeGeometryHashes(1e-3);
    api.setSourceBytes(bytes);
    const pre = api.buildPrePassOnce(bytes);
    const total = pre?.totalJobs ?? 0;
    if (total === 0) throw new Error('No geometry jobs were discovered');
    const rtc = pre?.rtcOffset ? Array.from(pre.rtcOffset) : [0, 0, 0];
    for (let s = 0; s < total; s += 512) {
      const e = Math.min(s + 512, total);
      const coll = api.processGeometryBatchFromSource(
        pre.jobs.slice(s * 3, e * 3), pre.unitScale ?? 1, rtc[0], rtc[1], rtc[2], pre.needsShift ?? false,
        pre.voidKeys ?? new Uint32Array(0), pre.voidCounts ?? new Uint32Array(0), pre.voidValues ?? new Uint32Array(0),
        pre.styleIds ?? new Uint32Array(0), pre.styleColors ?? new Uint8Array(0), pre.planeAngleToRadians,
        pre.materialElementIds, pre.materialColorCounts, pre.materialColors);
      try {
        for (let i = 0; i < coll.length; i++) {
          const mesh = coll.get(i);
          if (!mesh) continue;
          try {
            const id = mesh.expressId;
            const pos = mesh.positions;
            const idx = mesh.indices;
            // Renderer Y-up -> IFC Z-up: (x, y, z) -> (x, -z, y)
            const P = (k) => [pos[3 * k], -pos[3 * k + 2], pos[3 * k + 1]];
            let ext = extents.get(id);
            if (!ext) { ext = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; extents.set(id, ext); }
            for (let k = 0; k < pos.length / 3; k++) {
              const p = P(k);
              for (let d = 0; d < 3; d++) { ext.min[d] = Math.min(ext.min[d], p[d]); ext.max[d] = Math.max(ext.max[d], p[d]); }
            }
            if (wantedIds.has(id)) {
              const list = tris.get(id) ?? [];
              for (let t = 0; t < idx.length; t += 3) {
                const a = P(idx[t]), b = P(idx[t + 1]), c = P(idx[t + 2]);
                const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                const nn = cross(u, v);
                const area = Math.hypot(...nn) / 2;
                if (area > 1e-9) list.push({ n: norm3(nn), a: area });
              }
              tris.set(id, list);
            }
          } finally { mesh.free(); }
        }
      } finally { coll.free(); }
    }
  } finally {
    try { if (api.clearPrePassCache) api.clearPrePassCache(); } finally { api.free(); }
  }
  requireMeasuredExtents(extents);
  return { extents, tris };
}

// ----------------------------------------------------------------- extractor

export function requireMeasuredExtents(extents) {
  if (extents.size === 0 || [...extents.values()].some(ext => ![...ext.min,...ext.max].every(Number.isFinite))) {
    throw new Error('No complete finite mesh extents were measured');
  }
}

/** Every roof must have its own mesh or measured aggregate parts. */
export function requireRoofMeshes(model, roots, tris) {
  const pending = [...roots];
  const seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if ((tris.get(id) ?? []).some(t => Number.isFinite(t.a) && t.a > 0)) continue;
    const parts = model.partsOf.get(id) ?? [];
    if (!parts.length) throw new Error(`Missing roof mesh evidence for #${id}`);
    pending.push(...parts);
  }
}

export function roofSlopes(triLists) {
  // Cluster upward-facing, tilted triangles by (tilt, azimuth).
  const clusters = new Map();
  let flatArea = 0;
  let total = 0;
  for (const list of triLists) {
    for (const { n, a } of list) {
      if (n[2] < 0.05) continue; // downward or vertical face
      const tilt = (Math.acos(Math.min(1, n[2])) * 180) / Math.PI;
      total += a;
      if (tilt < 2) { flatArea += a; continue; }
      const az = ((Math.atan2(n[0], n[1]) * 180) / Math.PI + 360) % 360; // compass-like, clockwise from +Y
      const key = `${Math.round(tilt)}|${Math.round(az / 5) * 5 % 360}`;
      const c = clusters.get(key) ?? { tiltDeg: Math.round(tilt), azimuthDeg: Math.round(az / 5) * 5 % 360, area: 0 };
      c.area += a;
      clusters.set(key, c);
    }
  }
  const arr = [...clusters.values()].sort((x, y) => y.area - x.area).filter((c) => c.area > 0);
  const tilted = arr.reduce((s, c) => s + c.area, 0);
  const dirs = new Set(arr.map((c) => c.azimuthDeg));
  let form = 'none';
  if (total > 0) {
    if (tilted < 0.1 * total) form = 'flat';
    else if (dirs.size === 1) form = 'mono-pitch';
    else if (dirs.size === 2) form = 'gable';
    else if (dirs.size === 4) form = 'hip-or-pyramid';
    else form = 'complex';
  }
  return {
    inferredForm: form,
    totalUpwardArea: round(total, 2),
    flatArea: round(flatArea, 2),
    slopes: arr.map((c) => ({ tiltDeg: c.tiltDeg, azimuthDeg: c.azimuthDeg, area: round(c.area, 2) })),
  };
}

/** Default comparison tolerances for a hand-rebuilt model against the reference. */
export const TOLERANCES = {
  note: 'A model rebuilt by hand or by script will not match to the millimetre. Counts that a tool cannot split differently are exact; lengths and areas are relative.',
  elevationM: { kind: 'abs', value: 0.05 },
  floorToFloorM: { kind: 'abs', value: 0.05 },
  wallCountPerStorey: { kind: 'rel', value: 0.15, why: 'tools split walls at joins differently' },
  wallTotalLengthPerStorey: { kind: 'rel', value: 0.05 },
  doorCountPerStorey: { kind: 'exact' },
  windowCountPerStorey: { kind: 'exact' },
  openingSizeM: { kind: 'abs', value: 0.05 },
  stairCount: { kind: 'exact' },
  footprintBboxM: { kind: 'abs', value: 0.15 },
  roofForm: { kind: 'exact' },
  roofSlopeDeg: { kind: 'abs', value: 2 },
  roofSlopeAreaShare: { kind: 'rel', value: 0.1 },
  spaceCount: { kind: 'exact' },
  spaceAreaM2: { kind: 'rel', value: 0.05, why: 'net floor area; match spaces by name/number, not by order' },
};

export function dimensionKey(value, scale) {
  const n = numVal(value);
  return n === null ? 'unknown' : String(round(n * scale, 3));
}
export function sumKnown(values) {
  return values.some((value) => value === null) ? null : values.reduce((sum, value) => sum + value, 0);
}

export function storeyAtElevation(storeys, z) {
  let best = storeys[0]?.id ?? null;
  for (const st of storeys) if (st.placementZ <= z + 0.05) best = st.id;
  return best;
}

export function countRoofParts(model, roots) {
  return new Set(roots.flatMap((id) => model.partsOf.get(id) ?? [])).size;
}

export async function extract(refId_, entry, file) {
  const verification = await verifyPath(file, entry);
  if (verification.state !== 'ok') throw new Error(`Reference pin ${verification.state}: ${verification.detail ?? file}`);
  const buf = readFileSync(file);
  const text = buf.toString('latin1');
  const model = new Model(text);
  const S = model.lengthScale;

  const storeyIds = model.all('IFCBUILDINGSTOREY')
    .map((id) => {
      const a = model.get(id).args;
      const el = numVal(a[9]);
      const z = model.worldOrigin(id)[2];
      return { id, name: strVal(a[2]), elevation: (el ?? z / S) * S, placementZ: z };
    })
    .sort((x, y) => x.elevation - y.elevation);

  const roofRoots = [...model.all('IFCROOF'), ...model.all('IFCSLAB').filter((id) => enumVal(model.get(id).args[8]) === 'ROOF')];
  const roofParts = new Set();
  for (const r of roofRoots) { roofParts.add(r); for (const p of model.partsOf.get(r) ?? []) roofParts.add(p); }
  const spaceIds = model.all('IFCSPACE');
  const slabIds = model.all('IFCSLAB').filter((id) => enumVal(model.get(id).args[8]) !== 'ROOF');
  const wantedForTris = new Set([...roofParts, ...spaceIds, ...slabIds]);

  let mesh = null;
  let meshError = null;
  try { mesh = await meshPass(buf, wantedForTris); } catch (err) { meshError = String(err?.message ?? err); }

  const storeyFor = (id) => {
    const s = model.storeyOf(id);
    if (s) return s;
    const z = model.worldOrigin(id)[2];
    return storeyAtElevation(storeyIds, z);
  };

  const perStorey = new Map(storeyIds.map((s) => [s.id, { walls: [], doors: [], windows: [], slabs: [], stairs: [], stairFlights: [], spaces: [], columns: [], beams: [], roofs: [] }]));
  const bucket = (id, key) => { const s = storeyFor(id); if (s !== null && perStorey.has(s)) perStorey.get(s)[key].push(id); };

  const WALL = ['IFCWALL', 'IFCWALLSTANDARDCASE'];
  const wallIds = WALL.flatMap((t) => model.all(t));
  for (const id of wallIds) bucket(id, 'walls');
  for (const id of model.all('IFCDOOR')) bucket(id, 'doors');
  for (const id of model.all('IFCWINDOW')) bucket(id, 'windows');
  for (const id of slabIds) bucket(id, 'slabs');
  for (const id of model.all('IFCSTAIR')) bucket(id, 'stairs');
  for (const id of model.all('IFCSTAIRFLIGHT')) bucket(id, 'stairFlights');
  for (const id of spaceIds) bucket(id, 'spaces');
  for (const id of model.all('IFCCOLUMN')) bucket(id, 'columns');
  for (const id of model.all('IFCBEAM')) bucket(id, 'beams');
  for (const id of roofRoots) bucket(id, 'roofs');

  const wallLength = (id) => {
    const axis = model.axisPoints(id);
    if (axis) {
      let L = 0;
      for (let i = 1; i < axis.length; i++) L += Math.hypot(axis[i][0] - axis[i - 1][0], axis[i][1] - axis[i - 1][1], axis[i][2] - axis[i - 1][2]);
      return { length: L, source: 'axis-polyline' };
    }
    const p = model.props(id);
    const q = p['BaseQuantities.Length'] ?? p['Qto_WallBaseQuantities.Length'] ?? Object.entries(p).find(([k]) => k.endsWith('.Length'))?.[1];
    if (typeof q === 'number') return { length: q, source: 'quantity' };
    const ext = mesh?.extents.get(id);
    if (ext) return { length: Math.max(ext.max[0] - ext.min[0], ext.max[1] - ext.min[1]), source: 'mesh-extent-major' };
    return { length: null, source: 'none' };
  };

  const sizeKey = (id) => {
    const a = model.get(id).args;
    return `${dimensionKey(a[9], S)}x${dimensionKey(a[8], S)}`; // OverallWidth x OverallHeight
  };

  const spaceArea = (id) => {
    const p = model.props(id);
    const key = Object.keys(p).find((k) => /(^|\.)(NetFloorArea|GrossFloorArea|NetArea|GrossArea|GSA BIM Area|Area)$/i.test(k) && typeof p[k] === 'number');
    const prop = key ? { name: key, value: p[key] } : null;
    const tris = mesh?.tris.get(id);
    if (tris) {
      const a = tris.filter((t) => t.n[2] < -0.9).reduce((s, t) => s + t.a, 0);
      if (a > 0) return { area: a, source: 'mesh-floor-faces', prop };
    }
    if (prop) return { area: prop.value, source: `property:${prop.name}`, prop };
    return { area: null, source: 'none', prop: null };
  };

  const storeys = storeyIds.map((s, i) => {
    const b = perStorey.get(s.id);
    const next = storeyIds[i + 1];
    const walls = b.walls.map((id) => ({ id, ...wallLength(id)}));
    const lens = walls.map((w) => w.length);
    const slabTopArea = b.slabs.reduce((acc, id) => acc + (mesh?.tris.get(id) ?? []).filter((t) => t.n[2] > 0.9).reduce((x, t) => x + t.a, 0), 0);
    const spaces = b.spaces.map((id) => {
      const a = spaceArea(id);
      return {
        name: strVal(model.get(id).args[2]),
        longName: strVal(model.get(id).args[7]),
        number: strVal(model.get(id).args[2])?.match(/^\s*(\d+)/)?.[1] ?? null,
        area: a.area === null ? null : round(a.area, 2),
        areaSource: a.source,
        areaProperty: a.prop ? { name: a.prop.name, value: round(a.prop.value, 2) } : null,
        globalId: model.globalId(id),
      };
    }).sort((x, y) => (x.name ?? '').localeCompare(y.name ?? '', 'en', { numeric: true }));
    const sizes = (ids) => Object.fromEntries([...ids.reduce((m, id) => m.set(sizeKey(id), (m.get(sizeKey(id)) ?? 0) + 1), new Map())].sort());
    return {
      name: s.name,
      elevation: round(s.elevation, 3),
      floorToFloor: next ? round(next.elevation - s.elevation, 3) : null,
      walls: {
        count: b.walls.length,
        totalLength: sumKnown(lens) === null ? null : round(sumKnown(lens), 2),
        lengthSources: Object.fromEntries(walls.reduce((m, w) => m.set(w.source, (m.get(w.source) ?? 0) + 1), new Map())),
      },
      doors: { count: b.doors.length, widthXHeight: sizes(b.doors) },
      windows: { count: b.windows.length, widthXHeight: sizes(b.windows) },
      slabs: { count: b.slabs.length, topFaceArea: slabTopArea ? round(slabTopArea, 2) : null },
      stairs: b.stairs.length,
      stairFlights: b.stairFlights.length,
      columns: b.columns.length,
      beams: b.beams.length,
      spaces,
    };
  });

  // ---- footprint (world axes, from mesh extents) and orientation (from wall axes)
  let footprint = null;
  if (mesh) {
    // Lowest storey that holds spaces: skips footing / foundation pseudo-storeys.
    const lowest = (storeyIds.find((s) => perStorey.get(s.id).spaces.length > 0) ?? storeyIds[0])?.id;
    const inGround = [...(perStorey.get(lowest)?.walls ?? []), ...(perStorey.get(lowest)?.slabs ?? [])];
    const pick = inGround.map((id) => mesh.extents.get(id)).filter(Boolean);
    const all = pick.length ? pick : [...mesh.extents.values()];
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const e of all) for (let d = 0; d < 3; d++) { min[d] = Math.min(min[d], e.min[d]); max[d] = Math.max(max[d], e.max[d]); }
    // dominant wall direction -> rotation in [0,90)
    const hist = new Map();
    for (const id of wallIds) {
      const ax = model.axisPoints(id);
      if (!ax) continue;
      const a = Math.atan2(ax[ax.length - 1][1] - ax[0][1], ax[ax.length - 1][0] - ax[0][0]) * 180 / Math.PI;
      const k = ((Math.round(a) % 90) + 90) % 90;
      hist.set(k, (hist.get(k) ?? 0) + (Math.hypot(ax[ax.length - 1][0] - ax[0][0], ax[ax.length - 1][1] - ax[0][1])));
    }
    const rot = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const lowestSlabs = (perStorey.get(lowest)?.slabs ?? []);
    footprint = {
      basis: pick.length ? `walls and slabs of the lowest storey with spaces (${model.name(lowest)}), world-axis bounding box` : 'all elements, world-axis bounding box',
      storey: model.name(lowest),
      bboxWidthX: round(max[0] - min[0], 2),
      bboxDepthY: round(max[1] - min[1], 2),
      bboxHeightZ: round(max[2] - min[2], 2),
      dominantWallDirectionDeg: rot,
      slabCount: lowestSlabs.length,
      slabTopFaceArea: round(lowestSlabs.reduce((acc, id) => acc + (mesh.tris.get(id) ?? []).filter((t) => t.n[2] > 0.9).reduce((x, t) => x + t.a, 0), 0), 2),
    };
  }

  // ---- roof
  if (mesh) requireRoofMeshes(model, roofRoots, mesh.tris);
  const roofTris = [...roofParts].map((id) => mesh?.tris.get(id)).filter(Boolean);
  const roof = {
    elements: roofRoots.length,
    entityTypes: Object.fromEntries(roofRoots.reduce((m, id) => m.set(model.get(id).type, (m.get(model.get(id).type) ?? 0) + 1), new Map())),
    predefinedTypes: Object.fromEntries(roofRoots.reduce((m, id) => { const k = enumVal(model.get(id).args[8]) ?? 'n/a'; return m.set(k, (m.get(k) ?? 0) + 1); }, new Map())),
    parts: countRoofParts(model, roofRoots),
    ...(mesh ? roofSlopes(roofTris) : { inferredForm: 'unknown', note: meshError }),
  };

  const classCount = (types) => types.reduce((a, t) => a + model.all(t).length, 0);
  const spaces = storeys.flatMap((s) => s.spaces.map((sp) => ({ storey: s.name, ...sp })));
  return {
    schema: 'ifclite-parity-target/1',
    reference: refId_,
    source: { reference: refId_, licence: entry.licence?.status ?? null, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, ifcSchema: model.schema, lengthUnitMetres: S },
    generatedBy: 'tests/modelling-parity/references/extract-target.mjs',
    usedBy: entry.usedBy ?? [],
    tolerances: TOLERANCES,
    notes: entry.targetNotes ?? [],
    storeys,
    totals: {
      storeys: storeys.length,
      walls: storeys.reduce((a, s) => a + s.walls.count, 0),
      wallTotalLength: sumKnown(storeys.map((s) => s.walls.totalLength)) === null ? null : round(sumKnown(storeys.map((s) => s.walls.totalLength)), 2),
      doors: classCount(['IFCDOOR']),
      windows: classCount(['IFCWINDOW']),
      stairs: classCount(['IFCSTAIR']),
      stairFlights: classCount(['IFCSTAIRFLIGHT']),
      slabs: slabIds.length,
      columns: classCount(['IFCCOLUMN']),
      beams: classCount(['IFCBEAM']),
      spaces: spaceIds.length,
      totalSpaceArea: sumKnown(spaces.map((s) => s.area)) === null ? null : round(sumKnown(spaces.map((s) => s.area)), 2),
    },
    footprint,
    roof,
    spaces,
    meshPass: mesh ? 'ok' : `unavailable: ${meshError}`,
  };
}

// ----------------------------------------------------------------------- CLI

if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : null;
  const manifest = JSON.parse(readFileSync(resolve(HERE, 'manifest.json'), 'utf8'));
  const entry = manifest.references.find((r) => r.id === id);
  if (!entry) { console.error(`unknown reference '${id}'`); process.exit(2); }
  const file = resolveReferencePath(entry);
  if (!existsSync(file)) { console.error(`missing ${file}: run fetch-references.mjs first`); process.exit(2); }
  const result = await extract(id, entry, file);
  if (result.meshPass !== 'ok') throw new Error(result.meshPass);
  const json = JSON.stringify(result, null, 2) + '\n';
  if (args.includes('--check')) {
    if (!out || !existsSync(out) || readFileSync(out, 'utf8') !== json) { console.error(`${out} differs from a fresh extraction`); process.exit(1); }
    console.log('target spec is up to date');
  } else if (out) { writeFileSync(out, json); console.log(`wrote ${out}`); } else process.stdout.write(json);
}
