// SPDX-License-Identifier: MPL-2.0
// Packet structure only. Native proves geometry; no authored UV authority.
export function validatePlane(plane, side, mode) {
  plane = Array.from(plane);
  if (plane.length !== 6 || !plane.every(Number.isFinite) || plane.slice(3).every(x => x === 0) ||
      ![1, -1].includes(side) || ![2, 3].includes(mode)) throw new Error('invalid local metre plane');
}
export function planeCertificate(bytes, input, plane, side, mode) {
  validatePlane(plane, side, mode);
  if (bytes.byteLength < 312 || bytes.byteLength > 24520) throw new Error('invalid plane response size');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u = i => v.getUint32(i, true), f = i => v.getFloat64(i, true);
  const floats = (offset, count) => Array.from({ length: count }, (_, i) => f(offset + 8*i)), same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const output = bytes.slice(0, 16), count = u(308), method = u(20), sameHandle = (offset, expected) => same(bytes.slice(offset, offset + 16), expected);
  const version = u(16), base = 312 + 136*count;
  if (count > 16 || base > bytes.byteLength || ![1,2].includes(version) || u(24) !== 1 || u(28) > 1 ||
      !sameHandle(32, input) || !sameHandle(48, output) || sameHandle(0, input) ||
      !same(output.slice(0, 8), input.slice(0, 8)) || !u(12) || !new DataView(input.buffer, input.byteOffset).getUint32(12, true) ||
      new DataView(input.buffer, input.byteOffset).getBigUint64(0, true) === 0n ||
      u(64) !== (side >>> 0) || u(68) !== mode) throw new Error('invalid plane identity certificate');
  const original = new Uint8Array(48), pv = new DataView(original.buffer); plane.forEach((x, i) => pv.setFloat64(8*i, x, true));
  if (!same(bytes.slice(84, 132), original)) throw new Error('plane coefficient identity mismatch');
  const faces = u(72), edges = u(76), coefficients = u(80);
  if (method > 15 || faces > 100000 || edges > 100000 || coefficients > 1000000 ||
      Boolean(method & 4) !== (count > 0) || count > faces) throw new Error('invalid plane domain budget/method');
  const basis = floats(132, 9), domain = floats(204, 6), cutter = floats(252, 6), clearance = f(300);
  if (![...basis, ...domain, ...cutter, clearance].every(Number.isFinite)) throw new Error('nonfinite plane certificate');
  const scale = Math.max(...plane.slice(3).map(Math.abs)), n = plane.slice(3).map(x => x/scale), length = Math.hypot(...n), kept = side * (mode === 3 ? -1 : 1), eps = 64*Number.EPSILON;
  if (n.some((x, i) => Math.abs(basis[6+i] - kept*x/length) > eps)) throw new Error('invalid effective plane normal');
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const dot = [0,1,2].reduce((sum, k) => sum + basis[3*i+k]*basis[3*j+k], 0);
    if (Math.abs(dot - (i === j ? 1 : 0)) > eps) throw new Error('invalid effective plane basis');
  }
  const cross = [basis[1]*basis[5]-basis[2]*basis[4], basis[2]*basis[3]-basis[0]*basis[5], basis[0]*basis[4]-basis[1]*basis[3]];
  if (cross.some((x, i) => Math.abs(x-basis[6+i]) > eps)) throw new Error('reflected effective plane basis');
  if (method === 0) {
    if (u(28) !== 1 || faces || edges || coefficients || [...domain, ...cutter, clearance].some(x => x !== 0))
      throw new Error('invalid canonical empty plane domain');
  } else if (!faces || !edges || !coefficients || clearance <= 0 ||
      ![0,1,2].every(i => domain[i] < domain[i+3] && cutter[i] < cutter[i+3]) ||
      cutter[2] !== 0)
    throw new Error('invalid finite plane domain/cutter');
  const seen = new Set(); for (let i = 0; i < count; i++) {
    const offset = 312 + 136*i, face = u(offset);
    if (face >= faces || seen.has(face) || u(offset+4) > 1 || u(offset+8) > 1 || u(offset+12) !== 0 ||
        !floats(offset+16, 15).every(Number.isFinite) || f(offset+112) <= 0 || f(offset+120) >= f(offset+128))
      throw new Error('invalid cylinder conversion/domain certificate');
    seen.add(face);
  }
  const rectangles = sourceRectangles(bytes.slice(base), version, method, faces, edges, coefficients, seen);
  return Object.freeze({ output, empty: u(28) === 1, version, rectangles });
}
function sourceRectangles(bytes, version, method, faces, edges, coefficients, seen) {
  if (version === 1) {
    if (bytes.length || (method & 8)) throw new Error('unexpected source extension');
    return Object.freeze([]);
  }
  if (bytes.length < 16 || !(method & 8)) throw new Error('missing source extension');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u = i => view.getUint32(i, true);
  const count = u(0);
  if (count < 1 || count > 16 || u(4) !== 1376 || u(8) !== 248 || u(12) ||
      bytes.length !== 16 + 1376*count || count + seen.size > faces || coefficients < 12*count || edges < 4)
    throw new Error('invalid source extension layout/budget');
  const records = [];
  for (let i = 0; i < count; i++) {
    const record = sourceRectangle(bytes.slice(16 + 1376*i, 16 + 1376*(i+1)));
    if (record.sourceFace >= faces || seen.has(record.sourceFace)) throw new Error('duplicate or foreign source face inventory index');
    seen.add(record.sourceFace); records.push(record);
  }
  return Object.freeze(records);
}
const frozen = values => Object.freeze(values);
const clamped = k => k[0] === k[1] && k[2] === k[3] && k[0] < k[3];
const weights = c => c.every((v,i) => i % 4 !== 3 || v === 1 || v === -Number.MAX_VALUE);
const bitsEqual = (a,b) => a.every((v,i) => Object.is(v,b[i]));
function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    u: i => view.getUint32(i,true),
    f: (offset,count) => {
      const values = Array.from({ length: count }, (_,i) => view.getFloat64(offset+8*i,true));
      if (!values.every(Number.isFinite)) throw new Error('nonfinite source coefficient');
      return frozen(values);
    },
  };
}
function sourceRectangle(bytes) {
  const { u,f } = reader(bytes), axes = frozen([u(8),u(12),u(16)]);
  if (u(0) !== 1 || axes.some(a => a > 2) || new Set(axes).size !== 3 ||
      u(20) !== 1 || u(24) || u(28) !== 4 || u(32) !== 12 || u(36) || u(40) || u(44))
    throw new Error('invalid source rectangle header');
  const controls = f(48,16), uk = f(176,4), vk = f(208,4), bounds = f(240,6), uvHull = f(288,4), inverse = f(320,8);
  const [ua,va,na] = axes, expected = [uk[0],uk[3],controls[ua],controls[8+ua],vk[0],vk[3],controls[va],controls[4+va]];
  if (!weights(controls) || !clamped(uk) || !clamped(vk) || !bitsEqual(inverse,expected) ||
      !bitsEqual(uvHull,[uk[0],vk[0],uk[3],vk[3]]) || bounds[ua] >= bounds[ua+3] ||
      bounds[va] >= bounds[va+3] || bounds[na] !== bounds[na+3] ||
      controls[ua] === controls[8+ua] || controls[va] === controls[4+va])
    throw new Error('invalid source rectangle coefficient structure');
  for (let d = 0; d < 3; d++) {
    if ([0,1,2,3].some(i => controls[4*i+d] < bounds[d] || controls[4*i+d] > bounds[d+3]) ||
        Math.min(controls[d],controls[12+d]) !== bounds[d] || Math.max(controls[d],controls[12+d]) !== bounds[d+3] ||
        (d === ua && (controls[d] !== controls[4+d] || controls[8+d] !== controls[12+d])) ||
        (d === va && (controls[d] !== controls[8+d] || controls[4+d] !== controls[12+d])))
      throw new Error('invalid source rectangle control net');
  }
  const edges = [], seen = new Set();
  for (let i = 0; i < 4; i++) {
    const edge = sourceEdge(bytes.slice(384+248*i,384+248*(i+1)));
    if (seen.has(edge.startCorner)) throw new Error('duplicate rectangle boundary corner');
    seen.add(edge.startCorner); edges.push(edge);
  }
  boundaryStructure(edges,controls,bounds,ua,va);
  return frozen({ version: 1, sourceFace: u(4), axes, loops: 1, holes: 0, edgeCount: 4, controlCount: 12, flags: 0,
    controls, u: uk, v: vk, bounds, uvHull, inverse, edges: frozen(edges) });
}
function sourceEdge(bytes) {
  const { u,f } = reader(bytes), flags = u(0), startCorner = u(4), endCorner = u(8);
  if (flags > 3 || (!(flags & 1) && flags) || startCorner > 3 || endCorner > 3 ||
      [1,3,0,2][startCorner] !== endCorner || u(12)) throw new Error('invalid rectangle boundary header');
  const controls = f(16,8), knots = f(80,4), interval = f(112,2), start = f(128,3), end = f(152,3),
    lineOrigin = f(176,3), lineAxis = f(200,3), step = f(224,2), scale = f(240,1)[0];
  if (!weights(controls) || !clamped(knots) || interval[0] >= interval[1] || interval[0] < knots[0] ||
      interval[1] > knots[3] || start.every((v,i) => v === end[i]) ||
      ((flags & 1) && (scale <= 0 || step[0] >= step[1] || lineAxis.some(v => ![-1,0,1].includes(v)) ||
        lineAxis.filter(v => v !== 0).length !== 1)) ||
      (!(flags & 1) && [...lineOrigin,...lineAxis,...step,scale].some(v => v !== 0)))
    throw new Error('invalid rectangle boundary coefficient structure');
  return frozen({ flags, startCorner, endCorner, controls, knots, interval, start, end, lineOrigin, lineAxis, step, scale });
}

function boundaryStructure(edges,controls,bounds,ua,va) {
  const low = [Infinity,Infinity,Infinity], high = [-Infinity,-Infinity,-Infinity];
  for (const edge of edges) {
    for (const p of [edge.start,edge.end]) for (let d = 0; d < 3; d++) {
      if (p[d] < bounds[d] || p[d] > bounds[d+3]) throw new Error('boundary endpoint outside source support');
      low[d] = Math.min(low[d],p[d]);high[d] = Math.max(high[d],p[d]);
    }
    for (let d = 0; d < 3; d++) {
      if ([edge.controls[d],edge.controls[4+d]].some(v => v < bounds[d] || v > bounds[d+3]) ||
          (edge.start[d] === edge.end[d] && (edge.controls[d] !== edge.start[d] || edge.controls[4+d] !== edge.start[d])))
        throw new Error('boundary control hull outside rectangle side/support');
    }
  }
  if (low[ua] >= high[ua] || low[va] >= high[va]) throw new Error('collapsed rectangle boundary');
  const corner = p => {
    let code = 0;
    for (const [a,d] of [ua,va].entries()) {
      if (p[d] !== low[d] && p[d] !== high[d]) return undefined;
      const forward = controls[(a === 0 ? 8 : 4)+d] > controls[d];
      if (forward ? p[d] === high[d] : p[d] === low[d]) code |= 1 << a;
    }
    return code;
  };
  for (const edge of edges) {
    const a = corner(edge.start), b = corner(edge.end);
    if (!((a === edge.startCorner && b === edge.endCorner) || (a === edge.endCorner && b === edge.startCorner)))
      throw new Error('boundary endpoint/corner structure mismatch');
  }
}
