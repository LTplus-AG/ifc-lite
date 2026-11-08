/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared helpers for the modelling-parity SDK probes (#9296, lane L1).
 *
 * A probe is a script run by `node packages/cli/dist/index.js run <probe.js>
 * <blank.ifc>`; it gets the real headless `bim` context and loads this module
 * with `await import(process.env.PARITY_LIB)`. It authors on a blank model
 * through `bim.store`, exports IFC4, meshes the export with the shipped wasm
 * geometry kernel and checks geometry or data oracles. The runner
 * (`../run.mjs`) adds the shared result fields and writes the result file.
 *
 * Status rule: every oracle check passes -> pass; some pass -> partial;
 * none pass -> fail. A failed `core` check (the oracle that defines the
 * capability) makes the probe fail however many side checks pass. Setup that
 * throws is a failed check, never a pass.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = process.env.PARITY_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const BUILD = process.env.PARITY_BUILD_ROOT ?? ROOT;
const WORK = process.env.PARITY_WORK ?? join(ROOT, 'tests/modelling-parity/.out/L1/work');
const RESULT_FILE = process.env.PARITY_RESULT_FILE ?? null;

const msg = (e) => String(e?.message ?? e).split('\n')[0];
export const near = (a, b, tol = 1e-3) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
export const fmt = (v) => (Array.isArray(v) ? `[${v.map(fmt).join(', ')}]` : typeof v === 'number' ? (Math.round(v * 1000) / 1000).toString() : String(v));

// ── Wasm meshing ──────────────────────────────────────────────────────────

let apiPromise = null;
async function wasmApi() {
  apiPromise ??= (async () => {
    const mod = await import(pathToFileURL(join(BUILD, 'packages/wasm/pkg/ifc-lite.js')).href);
    mod.initSync({ module: new Uint8Array(readFileSync(join(BUILD, 'packages/wasm/pkg/ifc-lite_bg.wasm'))) });
    return new mod.IfcAPI();
  })();
  return apiPromise;
}

/** STEP index of an IFC text: GlobalId -> expressId, expressId -> upper-case type. */
export function stepIndex(content) {
  const byGuid = new Map(), typeOf = new Map();
  const re = /^#(\d+)\s*=\s*(IFC[A-Z0-9_]+)\s*\(\s*(?:'([^']{22})')?/gm;
  for (let m; (m = re.exec(content));) {
    const id = Number(m[1]);
    typeOf.set(id, m[2]);
    if (m[3]) byGuid.set(m[3], id);
  }
  return { byGuid, typeOf };
}

/** Mesh an IFC text; world-space Z-up metres, keyed by the exported expressId. */
export async function meshIfc(content) {
  const api = await wasmApi();
  const buffer = new TextEncoder().encode(content);
  const pre = api.buildPrePassOnce(buffer);
  const meshes = new Map();
  try {
    const off = pre.rtcOffset ? Array.from(pre.rtcOffset) : [0, 0, 0];
    const collection = api.processGeometryBatch(buffer, pre.jobs, pre.unitScale, off[0], off[1], off[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors, pre.planeAngleToRadians ?? null);
    try {
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        if (!mesh) continue;
        try {
          const p = mesh.positions, o = mesh.origin, idx = mesh.indices;
          const shift = pre.needsShift ? off : [0, 0, 0];
          const pts = new Float64Array(p.length);
          for (let j = 0; j < p.length; j += 3) {
            // Native mesh is Y-up; authoring parameters are IFC Z-up.
            pts[j] = o[0] + p[j] + shift[0];
            pts[j + 1] = -(o[2] + p[j + 2]) + shift[1];
            pts[j + 2] = o[1] + p[j + 1] + shift[2];
          }
          const entry = meshes.get(mesh.expressId) ?? { type: mesh.ifcType, parts: [] };
          entry.parts.push({ pts, idx: Uint32Array.from(idx) });
          meshes.set(mesh.expressId, entry);
        } finally { mesh.free(); }
      }
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); }
  return meshes;
}

export function bboxOfParts(parts) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const { pts } of parts) for (let j = 0; j < pts.length; j += 3) for (let k = 0; k < 3; k++) {
    if (pts[j + k] < min[k]) min[k] = pts[j + k];
    if (pts[j + k] > max[k]) max[k] = pts[j + k];
  }
  return Number.isFinite(min[0]) ? { min, max, size: max.map((v, k) => v - min[k]), centre: max.map((v, k) => (v + min[k]) / 2) } : null;
}

/** Absolute enclosed volume (m³) of closed triangle parts. */
export function volumeOfParts(parts) {
  let v = 0;
  for (const { pts, idx } of parts) {
    const b = [pts[0], pts[1], pts[2]];
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, c = idx[t + 1] * 3, d = idx[t + 2] * 3;
      const ax = pts[a] - b[0], ay = pts[a + 1] - b[1], az = pts[a + 2] - b[2];
      const cx = pts[c] - b[0], cy = pts[c + 1] - b[1], cz = pts[c + 2] - b[2];
      const dx = pts[d] - b[0], dy = pts[d + 1] - b[1], dz = pts[d + 2] - b[2];
      v += ax * (cy * dz - cz * dy) - ay * (cx * dz - cz * dx) + az * (cx * dy - cy * dx);
    }
  }
  return Math.abs(v / 6);
}

/** Ray-parity point-in-solid test over closed triangle parts. */
export function containsPoint(parts, p) {
  const dir = [0.8017, 0.4613, 0.3802]; // skewed so the ray avoids edges of axis-aligned boxes
  let hits = 0;
  for (const { pts, idx } of parts) {
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const e1 = [pts[b] - pts[a], pts[b + 1] - pts[a + 1], pts[b + 2] - pts[a + 2]];
      const e2 = [pts[c] - pts[a], pts[c + 1] - pts[a + 1], pts[c + 2] - pts[a + 2]];
      const h = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
      const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-12) continue;
      const s = [p[0] - pts[a], p[1] - pts[a + 1], p[2] - pts[a + 2]];
      const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) / det;
      if (v < 0 || u + v > 1) continue;
      if ((e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det > 1e-9) hits++;
    }
  }
  return hits % 2 === 1;
}

/** Classes counted by the census the output probe compares across a reopen (byType, so
 * non-rooted entities such as IfcGridAxis count too). */
export const CENSUS_CLASSES = ['IfcBuildingStorey', 'IfcWall', 'IfcSlab', 'IfcRoof', 'IfcColumn', 'IfcBeam', 'IfcMember', 'IfcPlate',
  'IfcDoor', 'IfcWindow', 'IfcOpeningElement', 'IfcStair', 'IfcStairFlight', 'IfcRailing', 'IfcCurtainWall', 'IfcSpace', 'IfcGrid',
  'IfcGridAxis', 'IfcCovering', 'IfcFooting', 'IfcRamp', 'IfcBuildingElementProxy', 'IfcMaterial', 'IfcWallType', 'IfcDoorType', 'IfcWindowType'];
export function census(bim) {
  const counts = {};
  for (const c of CENSUS_CLASSES) { const n = bim.query().byType(c).toArray().length; if (n) counts[c] = n; }
  return counts;
}

// ── Probe ─────────────────────────────────────────────────────────────────

export class Probe {
  constructor(bim, capability) {
    this.bim = bim;
    this.capability = capability;
    this.M = bim.model.activeId();
    this.checks = [];
    this.notes = [];
    this.metrics = {};
    this.evidence = [];
    this.artifacts = {};
    this.t0 = Date.now();
    mkdirSync(WORK, { recursive: true });
  }

  /** Storeys, lowest first. */
  levels() { return this.bim.store.listStoreyLevels(this.M).slice().sort((a, b) => a.elevation - b.elevation); }
  level(name) {
    const s = this.levels().find((x) => x.Name === name);
    if (!s) throw new Error(`no storey named ${name}`);
    return s;
  }
  ground() { return this.levels()[0]; }

  /** Setup step: returns the value, or null after recording why it failed. */
  step(label, fn) {
    try { return fn(); } catch (e) { this.notes.push(`${label} threw: ${msg(e)}`); return null; }
  }
  async stepAsync(label, fn) {
    try { return await fn(); } catch (e) { this.notes.push(`${label} threw: ${msg(e)}`); return null; }
  }

  /** One oracle check. `fn` returns true, false, or a string (failure detail); throwing fails it. */
  check(name, fn, { core = false } = {}) {
    let ok = false, detail = '';
    try {
      const r = typeof fn === 'function' ? fn() : fn;
      ok = r === true;
      if (!ok) detail = typeof r === 'string' ? r : 'oracle not met';
    } catch (e) { detail = `threw: ${msg(e)}`; }
    this.checks.push({ name, ok, ...(core ? { core } : {}), ...(ok ? {} : { detail }) });
    return ok;
  }
  async checkAsync(name, fn, opts) {
    let r;
    try { r = await fn(); } catch (e) { r = `threw: ${msg(e)}`; }
    return this.check(name, () => r, opts);
  }

  /** Export the session to IFC4, write it under the work dir and mesh it. */
  async exportModel(tag = this.capability, schema = 'IFC4') {
    const t = Date.now();
    const content = String(this.bim.export.ifc(null, { schema }));
    this.metrics.exportMs = (this.metrics.exportMs ?? 0) + (Date.now() - t);
    const path = join(WORK, `${tag}.${schema}.ifc`);
    writeFileSync(path, content);
    const rel = relative(ROOT, path).split('\\').join('/');
    if (!this.evidence.includes(rel)) this.evidence.push(rel);
    if (tag === this.capability) {
      this.artifacts.ifc = rel;
      this.artifacts.census = this.census();
    }
    return new ExportedModel(this, content, await meshIfc(content), rel);
  }

  /** Product counts by IFC type in the live session (the reopen oracle compares against it). */
  census() { return census(this.bim); }

  globalId(ref) {
    const id = typeof ref === 'number' ? ref : ref.expressId;
    return this.bim.entity({ modelId: this.M, expressId: id })?.globalId ?? null;
  }

  /** Write the result for the runner. Status from the oracle checks. */
  done(extra = {}) {
    const passed = this.checks.filter((c) => c.ok).length;
    const coreFailed = this.checks.some((c) => c.core && !c.ok);
    let status = extra.status ?? (this.checks.length === 0 ? 'error'
      : passed === this.checks.length ? 'pass' : passed > 0 && !coreFailed ? 'partial' : 'fail');
    const failed = this.checks.filter((c) => !c.ok).map((c) => `${c.core ? '[core] ' : ''}${c.name}: ${c.detail}`);
    let reason = extra.reason ?? (status === 'pass' ? undefined : failed.join('; ') || 'no oracle checks ran');
    if (this.notes.length && status !== 'pass') reason = `${reason} [setup: ${this.notes.join('; ')}]`;
    this.metrics.ms = Date.now() - this.t0;
    const out = {
      capability: this.capability, status, ...(reason ? { reason } : {}),
      metrics: { ...this.metrics, ...extra.metrics },
      checks: this.checks, notes: this.notes, evidence: this.evidence, artifacts: this.artifacts,
    };
    if (RESULT_FILE) writeFileSync(RESULT_FILE, JSON.stringify(out, null, 2));
    console.log(`[${this.capability}] ${status}${reason ? `: ${reason}` : ''}`);
    return out;
  }

  /** A capability with no SDK surface by design (UI-only or documentation). */
  skip(reason) { return this.done({ status: 'skip', reason }); }
}

/** An exported, meshed snapshot of the session. */
export class ExportedModel {
  constructor(probe, content, meshes, path) {
    this.probe = probe;
    this.content = content;
    this.meshes = meshes;
    this.path = path;
    this.index = stepIndex(content);
  }
  exportedId(ref) {
    const guid = this.probe.globalId(ref);
    return guid ? this.index.byGuid.get(guid) ?? null : null;
  }
  /** Mesh parts of a session element (and, with deep, its aggregated parts). */
  parts(ref, deep = false) {
    const refs = [typeof ref === 'number' ? ref : ref.expressId];
    if (deep) {
      const q = this.probe.bim;
      for (let i = 0; i < refs.length; i++) {
        for (const child of q.decomposes({ modelId: this.probe.M, expressId: refs[i] })) refs.push(child.ref.expressId);
      }
    }
    const out = [];
    for (const id of refs) {
      const x = this.exportedId(id);
      if (x != null && this.meshes.has(x)) out.push(...this.meshes.get(x).parts);
    }
    return out;
  }
  bbox(ref, deep = false) { return bboxOfParts(this.parts(ref, deep)); }
  volume(ref, deep = false) { return volumeOfParts(this.parts(ref, deep)); }
  contains(ref, point, deep = false) { return containsPoint(this.parts(ref, deep), point); }
  /** Exported STEP records of one IFC type (upper-case). */
  count(type) { let n = 0; for (const t of this.index.typeOf.values()) if (t === type) n++; return n; }
  has(re) { return re.test(this.content); }
}

/** Convenience used by every probe script. */
export function probe(bim, capability) { return new Probe(bim, capability); }
