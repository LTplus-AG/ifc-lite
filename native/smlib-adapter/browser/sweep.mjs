// SPDX-License-Identifier: MPL-2.0
// Numeric owned recipe transport only. IFC interpretation belongs to Rust.
export async function uploadSweep(transport, session, recipe, { loops, segments }, incarnation) {
  if (!(recipe instanceof Uint8Array) || !Number.isInteger(segments) || segments < 1 ||
      segments > 8192 || !Number.isInteger(loops) || loops < 1 || loops > 128 || loops > segments ||
      recipe.byteLength !== 48 + 8 * loops + 104 * segments ||
      recipe.byteLength > 1048576 || typeof session !== 'bigint' || session <= 0n || session > 0xffffffffffffffffn) throw new Error('invalid sweep declaration');
  recipe = new Uint8Array(recipe); // Own coefficients before the first await.
  const retire = () => {
    if (transport.retire) transport.retire(incarnation);
    else if (incarnation !== undefined && transport.incarnation === incarnation) transport.dispose();
  };
  function malformed(message) { retire(); throw new Error(message); }
  let sequence = 0;
  async function call(opcode, body) {
    const id = ++sequence;
    const frame = new ArrayBuffer(12 + body.byteLength);
    const view = new DataView(frame);
    view.setUint32(0, 1, true); view.setUint32(4, id, true); view.setUint32(8, opcode, true);
    new Uint8Array(frame, 12).set(body);
    const [response] = await transport.batch([frame], incarnation);
    if (!(response instanceof ArrayBuffer) || response.byteLength < 12) malformed('short sweep response');
    const result = new DataView(response);
    if (result.getUint32(0, true) !== 1 || result.getUint32(4, true) !== id) malformed('sweep response identity');
    const status = result.getInt32(8, true);
    if (status !== 0) throw Object.assign(new Error(`sweep status ${status}: ${new TextDecoder().decode(new Uint8Array(response, 12))}`), { domainStatus: status });
    return response.slice(12);
  }
  function body(length) {
    const bytes = new Uint8Array(length);
    new DataView(bytes.buffer).setBigUint64(0, session, true);
    return bytes;
  }
  const capability = await call(12, new Uint8Array());
  if (capability.byteLength !== 8 || new DataView(capability).getUint32(0, true) !== 1 ||
      !(new DataView(capability).getUint32(4, true) & 1)) malformed('staged sweep unavailable');
  const begin = body(24), beginView = new DataView(begin.buffer);
  [1, recipe.byteLength, loops, segments].forEach((value, i) => beginView.setUint32(8 + i * 4, value, true));
  const tokenBytes = await call(13, begin);
  if (tokenBytes.byteLength !== 8) malformed('invalid upload token');
  const token = new DataView(tokenBytes).getBigUint64(0, true);
  if (token === 0n) malformed('zero upload token');
  const finish = body(16); new DataView(finish.buffer).setBigUint64(8, token, true);
  let committing = false;
  let handle;
  try {
    for (let offset = 0; offset < recipe.byteLength; offset += 3840) {
      const chunk = recipe.subarray(offset, offset + 3840), bytes = body(24 + chunk.byteLength);
      const view = new DataView(bytes.buffer);
      view.setBigUint64(8, token, true); view.setUint32(16, offset, true);
      view.setUint32(20, chunk.byteLength, true); bytes.set(chunk, 24);
      if ((await call(14, bytes)).byteLength !== 0) malformed('unexpected chunk result');
    }
    committing = true;
    handle = await call(15, finish); // Never retry commit.
  } catch (error) {
    // Reported domain commits consumed the transaction. Unknown delivery may
    // have created a solid whose handle was lost: abort alone is insufficient.
    if (committing && error.domainStatus !== undefined) throw error;
    if (committing && error.submitted !== false) { retire(); throw error; }
    if (transport.incarnation !== incarnation) throw error;
    try { await call(16, finish); } catch (cleanup) {
      // Invalid chunks already discard the transaction. Retire this incarnation
      // on uncertain cleanup rather than reusing potentially incomplete state.
      retire();
      console.error('sweep cleanup retired worker', cleanup);
    }
    throw error;
  }

  if (handle.byteLength !== 16) malformed('invalid sweep handle');
  const value = new DataView(handle);
  if (value.getBigUint64(0, true) !== session || value.getUint32(12, true) === 0 ||
      transport.incarnation !== incarnation) malformed('foreign/stale sweep handle');
  return Object.freeze({ incarnation, bytes: handle });
}
