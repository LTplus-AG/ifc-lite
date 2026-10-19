// SPDX-License-Identifier: MPL-2.0
// Private wasm import. Deploy the canonical adapter assets at /smlib/.
// No caller transport, result, incarnation or qualification flag enters here.
export class RetainedDriver {
  #ready;
  #transport;
  #incarnation;
  #retired = false;
  #qualified = false;
  #busy = false;
  #sequence = 0;
  #session;
  #objects = new Map();
  #firstDispatch;
  #signalDispatch;
  constructor() {
    this.#firstDispatch = new Promise(resolve => { this.#signalDispatch = resolve; });
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
  firstDispatch() { return this.#firstDispatch; }
  retire() {
    if (this.#retired) return;
    this.#retired = true;
    this.#objects.clear(); // Invalidate leases before terminating transport.
    this.#transport?.retire(this.#incarnation);
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
    const pending = this.#transport.batch([frame], this.#incarnation);
    // Actual postMessage transfers/detaches the request synchronously. A
    // rejected unsent request never establishes this submission observation.
    if (frame.byteLength === 0) this.#signalDispatch();
    const [result] = await pending;
    if (!this.live()) throw new Error('worker expired during retained command');
    const response = new DataView(result);
    if (response.getUint32(0, true) !== 1 || response.getUint32(4, true) !== id) throw new Error('retained response identity');
    const status = response.getInt32(8, true);
    if (status !== 0) throw new Error(`retained status ${status}: ${new TextDecoder().decode(result.slice(12))}`);
    return new Uint8Array(result.slice(12));
  }
  async qualify() {
    await this.#ready;
    if (!this.live() || this.#busy) throw new Error('retained executor unavailable');
    this.#busy = true;
    this.#qualified = false;
    try {
      const { runSweepContract } = await import('/smlib/sweep-contract.mjs');
      await runSweepContract(this.#transport, this.#incarnation);
      if (!this.live()) throw new Error('qualification worker expired');
      this.#qualified = true;
    } catch (error) { this.retire(); throw error; }
    finally { this.#busy = false; }
  }
  async evaluate(bytes, format, loops, segments, qualification, chord, angle, maxBytes) {
    // Own every coefficient before awaiting initialization or asset loading.
    const recipe = new Uint8Array(bytes);
    if (![0, 1, 2].includes(qualification) || !Number.isFinite(chord) || chord <= 0 ||
        !Number.isFinite(angle) || angle <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('invalid retained evaluation limits');
    await this.#ready;
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
      const handle = await uploadSweep(this.#transport, sessionId, recipe, { format, loops, segments }, this.#incarnation);
      if (!this.live()) throw new Error('retained upload worker expired');
      const solid = new Uint8Array(handle.bytes);
      const meshHandle = await this.#call(9, this.#session, solid, f64(chord), f64(angle));
      validateHandle(meshHandle, sessionId);
      let mesh;
      try { mesh = await this.#readMesh(meshHandle, maxBytes); }
      catch (error) { this.retire(); throw error; }
      // Release the temporary mesh before sealing its independent copied arrays.
      await this.#call(8, this.#session, meshHandle);
      if (!this.live()) throw new Error('retained object owner expired');
      const object = Object.freeze({}); // Identity, not caller-visible wire bytes.
      this.#objects.set(object, solid);
      return { object, mesh };
    } catch (error) {
      // Unknown outcomes are never retried; the captured Worker owns all its
      // session allocations, including a solid whose response was lost.
      this.retire();
      throw error;
    } finally { this.#busy = false; }
  }
  async #readMesh(handle, maxBytes) {
    const info = await this.#call(10, this.#session, handle);
    if (info.byteLength !== 24) throw new Error('invalid retained mesh info');
    const view = new DataView(info.buffer);
    const [vertices, triangles, faces, boundary, spine, failures] = Array.from({ length: 6 }, (_, i) => view.getUint32(i * 4, true));
    const bytes = vertices * 3 * 8 + triangles * (3 * 4 + 9 * 8 + 4);
    if (!vertices || !triangles || !faces || boundary || spine || failures || !Number.isSafeInteger(bytes) || bytes > maxBytes ||
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
