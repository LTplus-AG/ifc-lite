// SPDX-License-Identifier: MPL-2.0
// Private wasm import of ifc-lite-wasm's retained browser executor. The
// canonical adapter bundle is deployed at /smlib/ (native/smlib-adapter/browser,
// staged by scripts/stage-retained-browser-assets.mjs). No caller transport,
// result, incarnation or qualification flag enters here.
//
// Every /smlib/ module is fetched by an explicit retained operation only.
// Bundlers must leave them outside ordinary viewer and geometry Worker builds.
function loadSdkModule(path) { return import(/* @vite-ignore */ path); }

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
  #releases = [];
  #cleanup;
  #dispatchListeners = [];
  constructor() {
    // Called only by explicit BrowserWorker construction. Importing the IFC
    // wasm package, or loading a model, never reaches this constructor.
    this.#ready = loadSdkModule('/smlib/client.mjs').then(({ SmlibWorkerTransport }) => {
      if (this.#retired) throw new Error('retained executor cancelled before startup');
      this.#transport = new SmlibWorkerTransport({ workerUrl: '/smlib/worker.mjs' });
      this.#incarnation = this.#transport.incarnation;
    });
    // A cancelled future may never await startup; keep its rejection observed.
    this.#ready.catch(error => { if (!this.#retired) console.error('retained worker startup', error); });
  }
  live() {
    return !this.#retired && (!this.#transport || this.#transport.incarnation === this.#incarnation);
  }
  objectLive(object) { return this.live() && this.#objects.has(object); }
  // Observation only, for the actual-Worker cancellation tests. Resolves when a
  // frame with this opcode is transferred; cannot submit work or grant authority.
  nextDispatch(opcode) {
    if (!Number.isSafeInteger(opcode) || opcode <= 0 || opcode > 0xffffffff)
      return Promise.reject(new Error('invalid dispatch observation opcode'));
    if (!this.live()) return Promise.reject(new Error('retired retained worker'));
    return new Promise((resolve, reject) => this.#dispatchListeners.push({ opcode, resolve, reject }));
  }
  retire() {
    if (this.#retired) return;
    this.#retired = true;
    this.#objects.clear(); // Invalidate leases before terminating the transport.
    this.#releases.length = 0;
    for (const listener of this.#dispatchListeners.splice(0)) listener.reject(new Error('retained worker retired before observed dispatch'));
    this.#transport?.retire(this.#incarnation);
  }
  // Invalidates the lease now; the release command runs before the next one.
  releaseObject(object) {
    const solid = this.#objects.get(object);
    if (!solid) return;
    this.#objects.delete(object);
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
      // Only a real transfer (detachment) proves submission.
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
  #observedTransport() {
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
    const [result] = await this.#batch([frame], this.#incarnation);
    if (!this.live()) throw new Error('worker expired during retained command');
    const response = new DataView(result);
    if (response.getUint32(0, true) !== 1 || response.getUint32(4, true) !== id) throw new Error('retained response identity');
    const status = response.getInt32(8, true);
    if (status !== 0) throw Object.assign(new Error(`retained status ${status}: ${new TextDecoder().decode(result.slice(12))}`), { kernelStatus: status });
    return new Uint8Array(result.slice(12));
  }
  async #acquire() {
    await this.#ready;
    await this.#awaitCleanup();
    if (!this.live() || this.#busy) throw new Error('retained executor unavailable');
    this.#busy = true;
  }
  #releaseBusy() { this.#busy = false; this.#scheduleReleases(); }
  // The actual Worker's SDK extension bits (opcode 12). Observation only: a
  // bit never qualifies a family; an unreadable reply retires the Worker.
  async capabilities() {
    await this.#acquire();
    try {
      const reply = await this.#call(12);
      const view = new DataView(reply.buffer);
      if (reply.byteLength !== 8 || view.getUint32(0, true) !== 1) throw new Error('invalid capability response');
      return view.getUint32(4, true);
    } catch (error) { this.retire(); throw error; }
    finally { this.#releaseBusy(); }
  }
  // Same-incarnation SDK witnesses (ordered regions and rational disks). A
  // failure retires the Worker; a replacement must qualify on its own.
  async qualify() {
    await this.#acquire();
    this.#qualified = false;
    try {
      const { runSweepContract } = await loadSdkModule('/smlib/sweep-contract.mjs');
      const report = await runSweepContract(this.#observedTransport(), this.#incarnation);
      if (!this.live()) throw new Error('qualification worker expired');
      this.#qualified = true;
      return report;
    } catch (error) { this.retire(); throw error; }
    finally { this.#releaseBusy(); }
  }
  async evaluate(bytes, format, loops, segments, qualification, chord, angle, maxBytes) {
    // Own every coefficient before awaiting initialization or asset loading.
    const recipe = new Uint8Array(bytes);
    if (![0, 1, 2].includes(qualification)) throw new Error('invalid retained qualification');
    if (!Number.isFinite(chord) || chord <= 0 || !Number.isFinite(angle) || angle <= 0 || angle > 180 ||
        !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('invalid retained evaluation limits');
    await this.#acquire();
    if (qualification !== 0 && !this.#qualified) {
      // Known refusal before submission: the Worker and its leases stay live.
      this.#releaseBusy();
      throw new Error('UnqualifiedRegion: execute same-incarnation numerical witnesses first');
    }
    let solid, meshHandle;
    try {
      const { uploadSweep } = await loadSdkModule('/smlib/sweep.mjs');
      if (!this.#session) {
        const session = await this.#call(1);
        if (session.byteLength !== 8 || new DataView(session.buffer).getBigUint64(0, true) === 0n) throw new Error('invalid retained session');
        this.#session = session;
      }
      const sessionId = new DataView(this.#session.buffer).getBigUint64(0, true);
      const handle = await uploadSweep(this.#observedTransport(), sessionId, recipe, { format, loops, segments }, this.#incarnation);
      if (!this.live()) throw new Error('retained upload worker expired');
      solid = new Uint8Array(handle.bytes);
      validateHandle(solid, sessionId);
      meshHandle = await this.#call(9, this.#session, solid, f64(chord), f64(angle));
      validateHandle(meshHandle, sessionId);
      const mesh = await this.#readMesh(meshHandle, maxBytes);
      // Release the temporary mesh before sealing its independent copied arrays.
      const released = meshHandle;
      meshHandle = undefined;
      await this.#releaseHandle(released);
      if (!this.live()) throw new Error('retained object owner expired');
      const object = Object.freeze({}); // Lease identity, never caller-visible wire bytes.
      this.#objects.set(object, solid);
      return Object.freeze({ object, mesh });
    } catch (error) {
      // The staged uploader names synchronized ABI refusals domainStatus.
      // Preserve that status at the runtime boundary as for direct commands.
      if (Number.isInteger(error.domainStatus)) error.kernelStatus = error.domainStatus;
      if (knownRefusal(error) && this.live()) {
        try {
          if (meshHandle) await this.#releaseHandle(meshHandle);
          if (solid) await this.#releaseHandle(solid);
        } catch (cleanupError) {
          this.retire();
          console.error('retained construction cleanup retired worker', cleanupError);
        }
      } else this.retire(); // Unknown outcomes, including lost handles, are never retried.
      throw error;
    } finally { this.#releaseBusy(); }
  }
  #solid(object) {
    if (!this.objectLive(object)) throw new Error('retired or foreign retained object');
    return this.#objects.get(object);
  }
  #seal(solid) {
    validateHandle(solid, new DataView(this.#session.buffer).getBigUint64(0, true));
    const object = Object.freeze({});
    this.#objects.set(object, solid);
    return object;
  }
  async #tessellateSolid(solid, chord, angle, maxBytes) {
    const empty = await this.#call(19, this.#session, solid);
    if (empty.byteLength !== 4) throw new Error('invalid retained empty certificate');
    const value = new DataView(empty.buffer).getUint32(0, true);
    if (value > 1) throw new Error('invalid retained empty certificate');
    if (value === 1) return { empty: true, mesh: null };
    const handle = await this.#call(9, this.#session, solid, f64(chord), f64(angle));
    validateHandle(handle, new DataView(this.#session.buffer).getBigUint64(0, true));
    let mesh;
    try { mesh = await this.#readMesh(handle, maxBytes); }
    catch (error) {
      if (knownRefusal(error)) await this.#releaseHandle(handle);
      throw error;
    }
    await this.#releaseHandle(handle);
    return { empty: false, mesh };
  }
  async #releaseHandle(handle) {
    try { await this.#call(8, this.#session, handle); }
    catch (error) { this.retire(); throw error; }
  }
  async tessellate(object, chord, angle, maxBytes) {
    limits(chord, angle, maxBytes);
    this.#solid(object);
    await this.#acquire();
    try { return await this.#tessellateSolid(this.#solid(object), chord, angle, maxBytes); }
    catch (error) {
      // The helper releases its temporary mesh on known refusals; the input
      // remains owned by its lease. Unknown outcomes retire the whole worker.
      if (!knownRefusal(error)) this.retire();
      throw error;
    }
    finally { this.#releaseBusy(); }
  }
  async affine(object, columnMajor) {
    const matrix = matrixBytes(columnMajor);
    this.#solid(object);
    await this.#acquire();
    try {
      const reply = await this.#call(18, this.#session, this.#solid(object), matrix);
      if (reply.byteLength !== 72) throw new Error('invalid affine copy reply');
      const certificate = reply.slice(16);
      const view = new DataView(certificate.buffer);
      if (view.getUint32(0, true) !== 1 || view.getUint32(4, true) !== 1)
        throw new Error('invalid affine certificate');
      for (const start of [8, 32]) {
        let count = 0;
        for (let i = 0; i < 6; i++) count += view.getUint32(start + i * 4, true);
        if (count > 100000) throw new Error('affine certificate class budget');
      }
      return { object: this.#seal(reply.slice(0, 16)), certificate };
    } catch (error) {
      // Status 8 means copying started; its allocations have an unknown outcome.
      // Other kernel refusals are pre-copy and preserve the input leases.
      if (!Number.isInteger(error.kernelStatus) || error.kernelStatus < 1 || error.kernelStatus > 7) this.retire();
      throw error;
    } finally { this.#releaseBusy(); }
  }
  async boolean(left, right, relativeColumnMajor, op, chord, angle, maxBytes) {
    limits(chord, angle, maxBytes);
    const matrix = matrixBytes(relativeColumnMajor);
    if (![1, 2, 3].includes(op)) throw new Error('invalid retained Boolean operation');
    this.#solid(left); this.#solid(right);
    await this.#acquire();
    let temporary, solid;
    try {
      const a = this.#solid(left), b = this.#solid(right);
      temporary = await this.#call(17, this.#session, b, matrix);
      validateHandle(temporary, new DataView(this.#session.buffer).getBigUint64(0, true));
      solid = await this.#call(5, this.#session, a, temporary, u32(op));
      const released = temporary;
      temporary = undefined;
      await this.#releaseHandle(released);
      validateHandle(solid, new DataView(this.#session.buffer).getBigUint64(0, true));
      const result = await this.#tessellateSolid(solid, chord, angle, maxBytes);
      return { object: this.#seal(solid), ...result };
    } catch (error) {
      if (knownRefusal(error)) {
        try {
          if (temporary) await this.#releaseHandle(temporary);
          if (solid) await this.#releaseHandle(solid);
        } catch (cleanupError) {
          this.retire();
          console.error('retained Boolean cleanup retired worker', cleanupError);
        }
      } else this.retire();
      throw error;
    }
    finally { this.#releaseBusy(); }
  }
  async #readMesh(handle, maxBytes) {
    const info = await this.#call(10, this.#session, handle);
    if (info.byteLength !== 24) throw new Error('invalid retained mesh info');
    const view = new DataView(info.buffer);
    const [vertices, triangles, faces, boundary, spine, failures] = Array.from({ length: 6 }, (_, i) => view.getUint32(i * 4, true));
    const bytes = vertices * 3 * 8 + triangles * (3 * 4 + 9 * 8 + 4);
    if (!vertices || !triangles || !faces || boundary || spine || failures || !Number.isSafeInteger(bytes) ||
        vertices * 3 > 0xffffffff || triangles * 9 > 0xffffffff) throw new Error('invalid or oversized retained mesh');
    if (bytes > maxBytes) throw Object.assign(new Error('oversized retained mesh'), { resourceLimit: true });
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
    return { positions, indices, flat_corner_normals, revision_local_faces, wire_info: info,
      source_face_count: faces, boundary_edges: boundary, spine_edges: spine };
  }
}
function validateHandle(bytes, session) {
  if (bytes.byteLength !== 16) throw new Error('invalid retained object handle');
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
  if (view.getBigUint64(0, true) !== session || !view.getUint32(12, true)) throw new Error('foreign retained object handle');
}
function u32(value) { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; }
function f64(value) { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value, true); return bytes; }

function limits(chord, angle, maxBytes) {
  if (!Number.isFinite(chord) || chord <= 0 || !Number.isFinite(angle) || angle <= 0 || angle > 180 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 0xffffffff)
    throw new Error('invalid retained evaluation limits');
}
function matrixBytes(values) {
  if (values.length !== 16 || !Array.from(values).every(Number.isFinite)) throw new Error('invalid retained matrix');
  const bytes = new Uint8Array(128), view = new DataView(bytes.buffer);
  for (let i = 0; i < 16; i++) view.setFloat64(i * 8, values[i], true);
  return bytes;
}

function knownRefusal(error) {
  return error.resourceLimit === true ||
    (Number.isInteger(error.kernelStatus) && error.kernelStatus >= 1 && error.kernelStatus <= 7);
}
