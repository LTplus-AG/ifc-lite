// SPDX-License-Identifier: MPL-2.0
// Private wasm import. Deploy the canonical adapter assets at /smlib/.
// No caller transport, result, incarnation or qualification flag enters here.
export class RetainedDriver {
  #ready;
  #transport;
  #incarnation;
  #retired = false;
  #qualified = false;
  #dependenciesQualified = false;
  #busy = false;
  #sequence = 0;
  #session;
  #objects = new Map();
  #releases = [];
  #cleanup;
  #dispatchListeners = [];
  constructor() {
    // This constructor is called only by explicit retained admission. In
    // particular, importing the default IFC wasm does not fetch an SDK module.
    this.#ready = import('/smlib/client.mjs').then(({ SmlibWorkerTransport }) => {
      if (this.#retired) throw new Error('retained executor cancelled before startup');
      this.#transport = new SmlibWorkerTransport({ workerUrl: '/smlib/worker.mjs' });
      this.#incarnation = this.#transport.incarnation;
    });
    // A cancelled future may never await startup; retain its rejection without
    // changing the original Promise observed by a still-active operation.
    this.#ready.catch(error => { if (!this.#retired) console.error('retained worker startup', error); });
  }
  live() {
    return !this.#retired && (!this.#transport || this.#transport.incarnation === this.#incarnation);
  }
  objectLive(object) { return this.live() && this.#objects.has(object); }
  // Observation only, used by the actual Worker cancellation invariant. This
  // Promise cannot submit work or change receipt/qualification authority.
  nextDispatch(opcode) {
    if (!Number.isSafeInteger(opcode) || opcode <= 0 || opcode > 0xffffffff)
      return Promise.reject(new Error('invalid dispatch observation opcode'));
    if (!this.live()) return Promise.reject(new Error('retired retained worker'));
    return new Promise((resolve, reject) => this.#dispatchListeners.push({ opcode, resolve, reject }));
  }
  retire() {
    if (this.#retired) return;
    this.#retired = true;
    this.#objects.clear(); // Invalidate leases before terminating transport.
    this.#releases.length = 0;
    for (const listener of this.#dispatchListeners.splice(0)) listener.reject(new Error('retained worker retired before observed dispatch'));
    this.#transport?.retire(this.#incarnation);
  }
  releaseObject(object) {
    const solid = this.#objects.get(object);
    if (!solid) return;
    this.#objects.delete(object); // Invalidate before the asynchronous release.
    this.#releases.push(solid);
    this.#scheduleReleases();
  }
  #scheduleReleases() {
    if (this.#busy || !this.live() || !this.#releases.length) return;
    // Acquire synchronously so another entry cannot race a cleanup command.
    this.#busy = true;
    this.#cleanup = this.#flushReleases().catch(error => {
      this.retire();
      console.error('retained object release retired captured worker', error);
    }).finally(() => { this.#cleanup = undefined; this.#busy = false; this.#scheduleReleases(); });
  }
  async #awaitCleanup() {
    while (this.#cleanup) await this.#cleanup;
  }
  async #flushReleases() {
    while (this.#releases.length) await this.#call(8, this.#session, this.#releases.shift());
  }
  #batch(frames, incarnation) {
    // Observe the captured actual transport, including staged upload commands.
    // This wrapper never manufactures responses or changes transport ownership.
    const opcodes = frames.map(frame => new DataView(frame).getUint32(8, true));
    const pending = this.#transport.batch(frames, incarnation);
    for (let i = 0; i < frames.length; i++) {
      // Only a real transfer/detachment proves submission. An unsent rejection
      // leaves the frame intact and must not satisfy a cancellation witness.
      if (frames[i].byteLength !== 0) continue;
      const waiting = [];
      for (const listener of this.#dispatchListeners) {
        if (listener.opcode === opcodes[i]) listener.resolve(opcodes[i]);
        else waiting.push(listener);
      }
      this.#dispatchListeners = waiting;
    }
    return pending;
  }
  #uploadTransport() {
    const transport = this.#transport;
    return Object.freeze({
      batch: (frames, incarnation) => this.#batch(frames, incarnation),
      retire: incarnation => transport.retire(incarnation),
      get incarnation() { return transport.incarnation; },
    });
  }
  async #call(opcode, ...fields) {
    if (!this.live() || !this.#transport) throw new Error('retired retained worker');
    if (this.#sequence >= 0xffffffff) throw new Error('retained request identity exhausted');
    const id = ++this.#sequence;
    const frame = new ArrayBuffer(12 + fields.reduce((n, a) => n + a.byteLength, 0));
    const view = new DataView(frame);
    [1, id, opcode].forEach((v, i) => view.setUint32(i * 4, v, true));
    let offset = 12;
    for (const field of fields) { new Uint8Array(frame, offset, field.byteLength).set(field); offset += field.byteLength; }
    const pending = this.#batch([frame], this.#incarnation);
    const [result] = await pending;
    if (!this.live()) throw new Error('worker expired during retained command');
    const response = new DataView(result);
    if (response.getUint32(0, true) !== 1 || response.getUint32(4, true) !== id) throw new Error('retained response identity');
    const status = response.getInt32(8, true);
    if (status !== 0) throw Object.assign(new Error(`retained status ${status}: ${new TextDecoder().decode(result.slice(12))}`), { kernelStatus: status });
    return new Uint8Array(result.slice(12));
  }
  async qualify() { return this.#qualify(false); }
  async qualifyDependencies() { return this.#qualify(true); }
  async #qualify(dependencies) {
    await this.#ready;
    await this.#awaitCleanup();
    if (!this.live() || this.#busy) throw new Error('retained executor unavailable');
    this.#busy = true;
    this.#qualified = false;
    this.#dependenciesQualified = false;
    try {
      const { runSweepContract } = await import('/smlib/sweep-contract.mjs');
      await runSweepContract(this.#transport, this.#incarnation);
      if (dependencies) {
        const { runContract } = await import('/smlib/contract.mjs');
        await runContract(frames => this.#transport.batch(frames, this.#incarnation));
      }
      if (!this.live()) throw new Error('qualification worker expired');
      this.#qualified = true;
      this.#dependenciesQualified = dependencies;
    } catch (error) { this.retire(); throw error; }
    finally { this.#busy = false; this.#scheduleReleases(); }
  }
  async evaluate(bytes, format, loops, segments, qualification, chord, angle, maxBytes) {
    // Own every coefficient before awaiting initialization or asset loading.
    const recipe = new Uint8Array(bytes);
    if (![0, 1, 2].includes(qualification)) throw new Error('invalid retained qualification');
    limits(chord, angle, maxBytes);
    await this.#ready;
    await this.#awaitCleanup();
    if (!this.live() || this.#busy) throw new Error('retained executor unavailable');
    if (qualification !== 0 && !this.#qualified) throw new Error('UnqualifiedRegion: execute same-incarnation numerical witnesses first');
    this.#busy = true;
    try {
      const { uploadSweep } = await import('/smlib/sweep.mjs');
      if (!this.#session) {
        const session = await this.#call(1);
        if (session.byteLength !== 8 || new DataView(session.buffer).getBigUint64(0, true) === 0n) throw new Error('invalid retained session');
        this.#session = session;
      }
      const sessionId = new DataView(this.#session.buffer).getBigUint64(0, true);
      const handle = await uploadSweep(this.#uploadTransport(), sessionId, recipe, { format, loops, segments }, this.#incarnation);
      if (!this.live()) throw new Error('retained upload worker expired');
      const solid = new Uint8Array(handle.bytes);
      validateHandle(solid, sessionId);
      return await this.#seal(solid, chord, angle, maxBytes, false);
    } catch (error) {
      // Unknown outcomes are never retried; the captured Worker owns all its
      // session allocations, including a solid whose response was lost.
      this.retire();
      throw error;
    } finally { this.#busy = false; this.#scheduleReleases(); }
  }
  async evaluateBoolean(left, right, relative, operation, chord, angle, maxBytes) {
    // Capture owned coefficients before the first await. Object tokens are only
    // accepted from this private driver's lease map, never from wire numbers.
    const matrix = Array.from(relative);
    properRigid(matrix);
    limits(chord, angle, maxBytes);
    if (![1, 2, 3].includes(operation)) throw new Error('invalid retained Boolean operation');
    if (!this.objectLive(left) || !this.objectLive(right)) throw new Error('foreign retained dependency');
    await this.#ready;
    await this.#awaitCleanup();
    if (!this.live() || this.#busy) throw new Error('retained executor unavailable');
    if (!this.#dependenciesQualified) throw new Error('unqualified retained dependencies');
    if (!this.objectLive(left) || !this.objectLive(right)) throw new Error('expired retained dependency');
    const a = this.#objects.get(left), b = this.#objects.get(right);
    this.#busy = true;
    try {
      const sessionId = new DataView(this.#session.buffer).getBigUint64(0, true);
      const moved = await this.#call(17, this.#session, b, ...matrix.map(f64));
      validateHandle(moved, sessionId);
      this.#assertNewSolid(moved);
      const solid = await this.#call(5, this.#session, a, moved, u32(operation));
      validateHandle(solid, sessionId);
      if (sameHandle(solid, moved)) throw new Error('Boolean result aliases temporary operand');
      this.#assertNewSolid(solid);
      await this.#call(8, this.#session, moved);
      return await this.#seal(solid, chord, angle, maxBytes, true);
    } catch (error) { this.retire(); throw error; }
    finally { this.#busy = false; this.#scheduleReleases(); }
  }
  // Candidate opcode18 seam: no display sampling, no automatic qualification.
  async copyAffine(source, matrixValues) {
    const matrix = Array.from(matrixValues);
    if (matrix.length !== 16 || matrix.some(x => !Number.isFinite(x) || Math.abs(x) > 1e9) ||
        matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1)
      throw new Error('invalid affine matrix');
    const determinant = matrix[0]*(matrix[5]*matrix[10]-matrix[9]*matrix[6]) -
      matrix[4]*(matrix[1]*matrix[10]-matrix[9]*matrix[2]) + matrix[8]*(matrix[1]*matrix[6]-matrix[5]*matrix[2]);
    if (determinant === 0) throw new Error('singular affine matrix');
    await this.#ready;
    await this.#awaitCleanup();
    if (!this.live() || this.#busy || !this.#objects.has(source)) throw new Error('invalid affine source lease');
    const input = this.#objects.get(source);
    this.#busy = true;
    try {
      const capability = await this.#call(12);
      if (capability.byteLength !== 8 || new DataView(capability.buffer).getUint32(0, true) !== 1)
        throw new Error('invalid affine capability payload');
      if (!(new DataView(capability.buffer).getUint32(4, true) & 16))
        throw Object.assign(new Error('affine rational copy unavailable'), { kernelStatus: 7 });
      const result = await this.#call(18, this.#session, input, ...matrix.map(f64));
      if (result.byteLength !== 72) throw new Error('invalid affine response');
      const solid = result.slice(0, 16), certificate = result.slice(16);
      const sessionId = new DataView(this.#session.buffer).getBigUint64(0, true);
      validateHandle(solid, sessionId);
      const view = new DataView(certificate.buffer);
      if (view.getUint32(0, true) !== 1 || view.getUint32(4, true) !== 1)
        throw new Error('invalid affine representation certificate');
      for (const base of [8, 32]) {
        let count = 0;
        for (let i = 0; i < 6; i++) count += view.getUint32(base + i*4, true);
        if (count > 100000) throw new Error('invalid affine class budget');
      }
      this.#assertNewSolid(solid);
      const object = Object.freeze({});
      this.#objects.set(object, solid);
      return { object, certificate };
    } catch (error) {
      // Synchronized typed refusal is transactional. Unknown/transport outcomes
      // still retire the captured domain, and are never automatically retried.
      if (!Number.isInteger(error.kernelStatus) || error.kernelStatus < 1 || error.kernelStatus > 7) this.retire();
      throw error;
    } finally { this.#busy = false; this.#scheduleReleases(); }
  }
  // Unary candidate only. The caller supplies no transport or positive evidence.
  async clipPlane(source, planeValues, side, mode, chord, angle, maxBytes) {
    const plane = Array.from(planeValues); validatePlane(plane, side, mode);
    limits(chord, angle, maxBytes);
    if (!this.objectLive(source)) throw new Error('foreign plane source lease');
    await this.#ready;
    await this.#awaitCleanup();
    if (!this.live() || this.#busy || !this.objectLive(source)) throw new Error('expired plane source lease');
    const input = this.#objects.get(source); this.#busy = true;
    let published = false;
    try {
      const capabilities = await this.#call(12);
      if (capabilities.byteLength !== 8 || new DataView(capabilities.buffer).getUint32(0, true) !== 1)
        throw new Error('invalid plane capability payload');
      if (!(new DataView(capabilities.buffer).getUint32(4, true) & 64))
        throw Object.assign(new Error('finite plane clipping unavailable'), { kernelStatus: 7 });
      // Source may have been dropped while negotiation was in flight.
      if (!this.objectLive(source)) throw new Error('expired plane source lease');
      const bytes = await this.#call(20, this.#session, input, ...plane.map(f64), u32(side >>> 0), u32(mode));
      published = true; // Later typed query/tessellation failure is not a clip refusal.
      const certificate = planeCertificate(bytes, input, plane, side, mode);
      const solid = certificate.output; this.#assertNewSolid(solid);
      const value = await this.#seal(solid, chord, angle, maxBytes, true);
      if (!this.objectLive(source)) throw new Error('plane source expired before acceptance');
      if ((value.outcome === 'empty') !== certificate.empty) throw new Error('plane Empty classification mismatch');
      const mesh = Object.freeze(Object.fromEntries(Object.entries(value.mesh).map(([key, v]) =>
        [key, ArrayBuffer.isView(v) ? Object.freeze(Array.from(v)) : v])));
      return Object.freeze({ ...value, mesh, input: Object.freeze(Array.from(input)), certificate: Object.freeze(Array.from(bytes)) });
    } catch (error) {
      if (published || !Number.isInteger(error.kernelStatus) || error.kernelStatus < 1 || error.kernelStatus > 7) this.retire();
      throw error;
    } finally { this.#busy = false; this.#scheduleReleases(); }
  }
  #assertNewSolid(solid) {
    if ([...this.#objects.values(), ...this.#releases].some(existing => sameHandle(existing, solid)))
      throw new Error('retained result aliases live input lease');
  }
  async #seal(solid, chord, angle, maxBytes, allowEmpty) {
    this.#assertNewSolid(solid);
    const sessionId = new DataView(this.#session.buffer).getBigUint64(0, true);
    const capabilities = await this.#call(12);
    if (capabilities.byteLength !== 8 || new DataView(capabilities.buffer).getUint32(0, true) !== 1 ||
        !(new DataView(capabilities.buffer).getUint32(4, true) & 32)) throw new Error('missing semantic empty query capability');
    const certificate = await this.#call(19, this.#session, solid);
    if (certificate.byteLength !== 4) throw new Error('invalid semantic empty query');
    const kind = new DataView(certificate.buffer).getUint32(0, true);
    if (kind > 1 || (kind === 1 && !allowEmpty)) throw new Error('invalid or empty retained construction');
    const empty = kind === 1;
    const meshHandle = await this.#call(9, this.#session, solid, f64(chord), f64(angle));
    validateHandle(meshHandle, sessionId);
    const mesh = await this.#readMesh(meshHandle, maxBytes, empty);
    await this.#call(8, this.#session, meshHandle);
    if (!this.live()) throw new Error('retained object owner expired');
    const object = Object.freeze({});
    this.#objects.set(object, solid);
    return Object.freeze({ object, mesh, outcome: empty ? 'empty' : 'nonempty' });
  }
  async #readMesh(handle, maxBytes, empty) {
    const info = await this.#call(10, this.#session, handle);
    if (info.byteLength !== 24) throw new Error('invalid retained mesh info');
    const view = new DataView(info.buffer);
    const [vertices, triangles, faces, boundary, spine, failures] = Array.from({ length: 6 }, (_, i) => view.getUint32(i * 4, true));
    const bytes = vertices * 3 * 8 + triangles * (3 * 4 + 9 * 8 + 4);
    const consistent = empty ? [vertices, triangles, faces, boundary, spine, failures].every(n => n === 0)
      : vertices > 0 && triangles > 0 && faces > 0;
    if (!consistent || boundary || spine || failures || !Number.isSafeInteger(bytes) || bytes > maxBytes ||
        vertices * 3 > 0xffffffff || triangles * 9 > 0xffffffff) throw new Error('invalid or oversized retained mesh');
    const read = async (stream, count, width) => {
      const values = width === 8 ? new Float64Array(count) : new Uint32Array(count);
      for (let offset = 0; offset < count; offset += 480) {
        const length = Math.min(480, count - offset);
        const chunk = await this.#call(11, this.#session, handle, u32(stream), u32(offset), u32(length));
        if (chunk.byteLength !== length * width) throw new Error('short retained mesh chunk');
        const data = new DataView(chunk.buffer);
        for (let i = 0; i < length; i++) {
          const value = width === 8 ? data.getFloat64(i * width, true) : data.getUint32(i * width, true);
          if (!Number.isFinite(value)) throw new Error('nonfinite retained mesh');
          values[offset + i] = value;
        }
      }
      return values;
    };
    const positions = await read(1, vertices * 3, 8);
    const indices = await read(2, triangles * 3, 4);
    const revision_local_faces = await read(3, triangles, 4);
    const flat_corner_normals = await read(4, triangles * 9, 8);
    if (indices.some(i => i >= vertices) || revision_local_faces.some(i => i >= faces)) throw new Error('retained mesh index bound');
    return { positions, indices, flat_corner_normals, revision_local_faces,
      source_face_count: faces, boundary_edges: boundary, spine_edges: spine };
  }
}
function validateHandle(bytes, session) {
  if (bytes.byteLength !== 16) throw new Error('invalid retained object handle');
  const view = new DataView(bytes.buffer);
  if (view.getBigUint64(0, true) !== session || !view.getUint32(12, true)) throw new Error('foreign retained object handle');
}
function u32(value) { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; }
function f64(value) { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value, true); return bytes; }
function limits(chord, angle, maxBytes) {
  if (!Number.isFinite(chord) || chord <= 0 || !Number.isFinite(angle) || angle <= 0 || angle > 180 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('invalid retained evaluation limits');
}
function properRigid(m) {
  if (m.length !== 16 || !m.every(Number.isFinite) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1)
    throw new Error('retained dependency requires proper rigid metre frame');
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let dot = 0;
    for (let k = 0; k < 3; k++) dot += m[i * 4 + k] * m[j * 4 + k];
    if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-12) throw new Error('nonrigid retained frame');
  }
  const cross = [m[1]*m[6]-m[2]*m[5], m[2]*m[4]-m[0]*m[6], m[0]*m[5]-m[1]*m[4]];
  if (cross.some((v, i) => Math.abs(v - m[8 + i]) > 1e-12)) throw new Error('reflected retained frame');
}
function sameHandle(a, b) { return a.byteLength === b.byteLength && a.every((value, i) => value === b[i]); }
function validatePlane(plane, side, mode) {
  if (plane.length !== 6 || !plane.every(Number.isFinite) || plane.slice(3).every(x => x === 0) ||
      ![1, -1].includes(side) || ![2, 3].includes(mode)) throw new Error('invalid local metre plane');
}
function planeCertificate(bytes, input, plane, side, mode) {
  validatePlane(plane, side, mode);
  if (bytes.byteLength < 312 || bytes.byteLength > 2488) throw new Error('invalid plane response size');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u = i => v.getUint32(i, true), f = i => v.getFloat64(i, true);
  const floats = (offset, count) => Array.from({ length: count }, (_, i) => f(offset + 8*i)), same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const output = bytes.slice(0, 16), count = u(308), method = u(20), sameHandle = (offset, expected) => same(bytes.slice(offset, offset + 16), expected);
  if (count > 16 || bytes.byteLength !== 312 + 136*count || u(16) !== 1 || u(24) !== 1 || u(28) > 1 ||
      !sameHandle(32, input) || !sameHandle(48, output) || sameHandle(0, input) ||
      !same(output.slice(0, 8), input.slice(0, 8)) || !u(12) || !new DataView(input.buffer, input.byteOffset).getUint32(12, true) ||
      new DataView(input.buffer, input.byteOffset).getBigUint64(0, true) === 0n ||
      u(64) !== (side >>> 0) || u(68) !== mode) throw new Error('invalid plane identity certificate');
  const original = new Uint8Array(48), pv = new DataView(original.buffer); plane.forEach((x, i) => pv.setFloat64(8*i, x, true));
  if (!same(bytes.slice(84, 132), original)) throw new Error('plane coefficient identity mismatch');
  const faces = u(72), edges = u(76), coefficients = u(80);
  if (method > 7 || faces > 100000 || edges > 100000 || coefficients > 1000000 ||
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
  return Object.freeze({ output, empty: u(28) === 1 });
}
