/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

function sourceKey(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return `${bytes.length.toString(16)}-${(hash >>> 0).toString(16)}`;
}

function capture(IfcAPI, bytes, sharded, fingerprint, geometry = false) {
  const api = new IfcAPI();
  try {
    const events = [];
    const args = [bytes, event => events.push(event), 1024, undefined, true];
    const ordinary = sharded ? 'buildPrePassStreamingSharded' : 'buildPrePassStreaming';
    const enhanced = `${ordinary}WithSourceFingerprint`;
    if (sharded) {
      const index = api.scanEntityIndexShard(bytes, 0, bytes.length);
      args.push(index.ids, index.starts, index.lengths, index.classes);
    }
    const method = fingerprint && typeof api[enhanced] === 'function' ? enhanced : ordinary;
    api[method](...args);
    const complete = events.find(event => event.type === 'complete');
    assert.ok(complete, 'real prepass must complete');
    const meshes = geometry ? captureCompletedGeometry(IfcAPI, api, bytes, events) : undefined;
    return { key: complete.sourceContentKey, meshes,
      events: events.map(({ sourceContentKey: _key, ...event }) => event) };
  } finally {
    api.clearPrePassCache();
    api.free();
  }
}

/** Actual WASM methods, including optional matched historical JS/WASM pairs. */
export function checkSourceFingerprintContract(IfcAPI, source, enhancedAvailable) {
  const probe = new IfcAPI();
  try {
    for (const name of ['buildPrePassStreamingWithSourceFingerprint', 'buildPrePassStreamingShardedWithSourceFingerprint']) {
      assert.equal(typeof probe[name] === 'function', enhancedAvailable, `${name} capability`);
    }
  } finally { probe.free(); }
  const tail = new Uint8Array(source.length + 22);
  tail.set(source);
  tail.set(new TextEncoder().encode('\n/* unclosed tail'), source.length);
  tail[tail.length - 2] = 0;
  tail[tail.length - 1] = 255;
  // Full file and malformed/binary tail must both keep the old job pipeline.
  for (const bytes of [source, tail]) {
    for (const sharded of [false, true]) {
      const baseline = capture(IfcAPI, bytes, sharded, false);
      const candidate = capture(IfcAPI, bytes, sharded, true);
      assert.equal(baseline.key, undefined, 'ordinary methods retain their original behavior');
      assert.deepEqual(candidate.events, baseline.events, 'fingerprinting must not change prepass jobs or metadata');
      assert.equal(candidate.key, enhancedAvailable ? sourceKey(bytes) : undefined);
    }
  }
}

/** Exercise the SAME completed streaming API before its cache is cleared.
 * A separate API supplies canonical styles for the externally-styled sharded
 * mode; it cannot replace or repair the streaming API's retained entity index.
 */
function captureCompletedGeometry(IfcAPI, api, bytes, events) {
  const stylesApi = new IfcAPI();
  let styles;
  try { styles = stylesApi.buildPrePassOnce(bytes); }
  finally { stylesApi.clearPrePassCache(); stylesApi.free(); }
  const meta = events.find(event => event.type === 'meta');
  assert.ok(meta, 'streaming metadata must precede geometry');
  const meshes = [];
  for (const event of events) {
    if (event.type !== 'jobs' || !event.jobs.length) continue;
    const collection = api.processGeometryBatch(bytes, event.jobs, meta.unitScale,
      ...meta.rtcOffset, meta.needsShift, styles.voidKeys, styles.voidCounts,
      styles.voidValues, styles.styleIds, styles.styleColors);
    try {
      for (let row = 0; row < collection.length; row++) {
        const mesh = collection.get(row);
        if (!mesh) continue;
        try {
          meshes.push({ expressId: mesh.expressId, ifcType: mesh.ifcType,
            positions: mesh.positions, normals: mesh.normals, indices: mesh.indices,
            color: mesh.color, vertexCount: mesh.vertexCount, triangleCount: mesh.triangleCount,
            geometryClass: mesh.geometryClass, geometryItemId: mesh.geometryItemId,
            materialId: mesh.materialId, origin: mesh.origin });
        } finally { mesh.free(); }
      }
    } finally { collection.free(); }
  }
  return { meshes, styles };
}

/** #3985: same-mode actual runtime comparison, including retained old pairs.
 * An old module without fingerprint wrappers is compared through its original
 * methods; the candidate's new wrapper additionally remains exact-key checked.
 */
export function checkPrepassReservationContract(IfcAPI, BaselineIfcAPI, sources) {
  for (const bytes of sources) {
    for (const sharded of [false, true]) {
      const baseline = capture(BaselineIfcAPI, bytes, sharded, false, true);
      for (const fingerprint of [false, true]) {
        const candidate = capture(IfcAPI, bytes, sharded, fingerprint, true);
        assert.deepEqual(candidate.events, baseline.events,
          'same-mode ordered jobs, index, metadata and styles must match retained runtime');
        assert.deepEqual(candidate.meshes, baseline.meshes,
          'completed prepass must preserve cached-index geometry and canonical styles');
        assert.equal(candidate.key, fingerprint ? sourceKey(bytes) : undefined);
      }
    }
  }
}
