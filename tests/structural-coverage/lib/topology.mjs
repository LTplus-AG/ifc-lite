/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a structural item's topology sits, read from the file alone: the
 * oracle of the member render probe. Like `step.mjs` it shares no code with
 * the product. It follows the item's `IfcTopologyRepresentation` (vertex,
 * edge, oriented edge, face bound) through its `IfcLocalPlacement` chain into
 * IFC world coordinates, in metres, Z up.
 *
 * Only the topology vertices are returned, not curve interiors: a drawn axis
 * or surface has to reach every one of them.
 */

const PREFIX = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9 };

const enumOf = (v) => (v && typeof v === 'object' && 'enum' in v ? v.enum : undefined);
const refOf = (v) => (v && typeof v === 'object' && 'ref' in v ? v.ref : undefined);
const numberOf = (v) => (typeof v === 'number' ? v : v && typeof v === 'object' && 'value' in v ? numberOf(v.value) : undefined);

/** Metres per unit of an `IfcSIUnit` or `IfcConversionBasedUnit` record, or undefined when it is neither. */
function unitScale(step, unit, depth = 0) {
  if (unit?.type === 'IFCSIUNIT') return PREFIX[enumOf(unit.args[2])] ?? 1;
  if (unit?.type !== 'IFCCONVERSIONBASEDUNIT' || depth > 4) return undefined;
  const measure = step.get(unit.args[3]);
  const factor = numberOf(measure?.args[0]);
  const base = unitScale(step, step.get(measure?.args[1]), depth + 1);
  return factor && base ? factor * base : undefined;
}

/** Metres per file length unit: the project's `LENGTHUNIT` in its `UnitsInContext`, else metres. */
export function lengthScale(step) {
  for (const project of step.of('IfcProject')) {
    for (const ref of step.get(project.args[8])?.args[0] ?? []) {
      const unit = step.get(ref);
      if (enumOf(unit?.args[1]) === 'LENGTHUNIT') return unitScale(step, unit) ?? 1;
    }
  }
  return 1;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a); return l > 1e-12 ? a.map((c) => c / l) : null; };
/** A point in `f`'s axes, in its parent's. */
const apply = (f, p) => [0, 1, 2].map((i) => f.o[i] + f.x[i] * p[0] + f.y[i] * p[1] + f.z[i] * p[2]);
const rotate = (f, v) => [0, 1, 2].map((i) => f.x[i] * v[0] + f.y[i] * v[1] + f.z[i] * v[2]);
const IDENTITY = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function coords(step, id) {
  const r = step.get(id);
  if (r?.type !== 'IFCCARTESIANPOINT' && r?.type !== 'IFCDIRECTION') return null;
  const c = r.args[0].map(numberOf);
  return c.length >= 2 && c.every(Number.isFinite) ? [c[0], c[1], c[2] ?? 0] : null;
}

/** `IfcAxis2Placement3D`: z = Axis, x = RefDirection made normal to z; IFC defaults otherwise. */
function axisPlacement(step, id) {
  const r = step.get(id);
  if (r?.type !== 'IFCAXIS2PLACEMENT3D') return null;
  const o = coords(step, refOf(r.args[0]));
  if (!o) return null;
  const z = unit(coords(step, refOf(r.args[1])) ?? [0, 0, 1]) ?? [0, 0, 1];
  const ref = coords(step, refOf(r.args[2])) ?? (Math.abs(z[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0]);
  const x = unit(sub(ref, z.map((c) => c * dot(ref, z)))) ?? unit(cross([0, 1, 0], z));
  return x && { o, x, y: cross(z, x), z };
}

/** World frame of an `IfcLocalPlacement` chain, in file units; null for a cycle or another placement kind. */
function placementFrame(step, id) {
  const chain = [];
  const seen = new Set();
  for (let at = id; at !== undefined; at = refOf(step.get(at)?.args[0])) {
    if (seen.has(at)) return null;
    seen.add(at);
    const r = step.get(at);
    if (r?.type !== 'IFCLOCALPLACEMENT') return null;
    chain.push(r);
  }
  let frame = IDENTITY;
  for (const r of chain.reverse()) {
    const local = axisPlacement(step, refOf(r.args[1]));
    if (!local) return null;
    frame = { o: apply(frame, local.o), x: rotate(frame, local.x), y: rotate(frame, local.y), z: rotate(frame, local.z) };
  }
  return frame;
}

/** The vertex points under one topology item, in its product's axes. Bounded: edges nest at most 16 deep. */
function topologyVertices(step, id, depth = 0) {
  const r = step.get(id);
  if (!r || depth > 16) return [];
  const vertex = (v) => { const p = step.get(v); return p?.type === 'IFCVERTEXPOINT' ? [coords(step, refOf(p.args[0]))].filter(Boolean) : []; };
  switch (r.type) {
    case 'IFCVERTEXPOINT': return vertex({ ref: id });
    case 'IFCEDGE': case 'IFCEDGECURVE': case 'IFCSUBEDGE': return [...vertex(r.args[0]), ...vertex(r.args[1])];
    case 'IFCORIENTEDEDGE': return topologyVertices(step, refOf(r.args[2]), depth + 1);
    case 'IFCFACE': case 'IFCFACESURFACE': case 'IFCADVANCEDFACE':
      return r.args[0].flatMap((b) => {
        const loop = step.get(step.get(b)?.args[0]);
        if (loop?.type === 'IFCPOLYLOOP') return loop.args[0].map((p) => coords(step, refOf(p))).filter(Boolean);
        if (loop?.type === 'IFCEDGELOOP') return loop.args[0].flatMap((e) => topologyVertices(step, refOf(e), depth + 1));
        return [];
      });
    default: return [];
  }
}

/**
 * The topology vertices of a product, in IFC world metres. Empty when the file
 * gives it no topology representation, or a placement this oracle does not follow.
 */
export function topologyPoints(step, productId, scale = lengthScale(step)) {
  const product = step.get(productId);
  const placementId = refOf(product?.args[5]);
  const frame = placementId === undefined ? IDENTITY : placementFrame(step, placementId);
  const shape = step.get(product?.args[6]);
  if (!frame || !shape) return [];
  const points = [];
  for (const repRef of shape.args[2] ?? []) {
    const rep = step.get(repRef);
    if (rep?.type !== 'IFCTOPOLOGYREPRESENTATION') continue;
    for (const item of rep.args[3] ?? []) points.push(...topologyVertices(step, refOf(item)));
  }
  return points.map((p) => apply(frame, p).map((c) => c * scale));
}

/** Distance from point `p` to triangle `a b c` (all 3-vectors). */
function triangleDistance(p, a, b, c) {
  const ab = sub(b, a); const ac = sub(c, a); const ap = sub(p, a);
  const d1 = dot(ab, ap); const d2 = dot(ac, ap);
  const at = (s, t) => Math.hypot(...sub(p, [0, 1, 2].map((i) => a[i] + ab[i] * s + ac[i] * t)));
  if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);
  const bp = sub(p, b); const d3 = dot(ab, bp); const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);
  const cp = sub(p, c); const d5 = dot(ab, cp); const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return Math.hypot(...sub(p, [0, 1, 2].map((i) => b[i] + (c[i] - b[i]) * w)));
  }
  const denom = 1 / (va + vb + vc);
  return at(vb * denom, vc * denom);
}

/**
 * Distance from an IFC world point (metres, Z up) to the nearest triangle of
 * `meshes`: the geometry module's output, `origin + positions` in the render
 * frame (Y up), which sits `originShift` plus the wasm RTC offset away from
 * IFC world (`coordinateInfo`). Infinity without triangles.
 */
export function meshDistance(meshes, [x, y, z], info = {}) {
  const shift = info.originShift ?? { x: 0, y: 0, z: 0 };
  const rtc = info.wasmRtcOffset ?? { x: 0, y: 0, z: 0 };
  const p = [x - shift.x - rtc.x, z - shift.y - rtc.z, -y - shift.z + rtc.y];
  let best = Infinity;
  for (const m of meshes) {
    const o = m.origin ?? [0, 0, 0];
    const v = (i) => [o[0] + m.positions[3 * i], o[1] + m.positions[3 * i + 1], o[2] + m.positions[3 * i + 2]];
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
      // A degenerate triangle measures NaN, which this comparison skips.
      const d = triangleDistance(p, v(m.indices[t]), v(m.indices[t + 1]), v(m.indices[t + 2]));
      if (d < best) best = d;
    }
  }
  return best;
}
