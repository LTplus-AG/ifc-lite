// SPDX-License-Identifier: MPL-2.0
// JS assertions on actual returned WASM values, not mock return objects.
// Keep fixture imports inside caught async test calls: a static missing module
// prevents wasm-bindgen-test itself from loading and reporting any test result.
async function loadModule(path) {
  let timer;
  try {
    return await Promise.race([
      import(path),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('module load timed out')), 10_000);
      }),
    ]);
  } catch (cause) {
    throw new Error(`Retained test module ${path} failed to load: ${cause.message}`, { cause });
  } finally {
    clearTimeout(timer);
  }
}
export async function driverFactory() {
  const { RetainedDriver } = await loadModule('/retained-test/retained-driver.mjs');
  return () => new RetainedDriver();
}
export async function assertMissingModuleReported() {
  const path = '/retained-test/deliberately-missing.mjs';
  try {
    await loadModule(path);
  } catch (error) {
    check(error.message.includes(path) && error.cause instanceof Error, 'module error preserves path and cause');
    return;
  }
  throw new Error('missing test module unexpectedly loaded');
}
function check(value, message) { if (!value) throw new Error(message); }
export async function preparePeer(failAt) {
  const { peers, nextPeer } = await loadModule('/retained-test/peer.mjs');
  const start = peers.length;
  if (failAt) nextPeer().then(peer => {
    peer.failOpcode = 10;
    peer.failAtOccurrence = failAt;
    peer.kernelStatus = 4;
  });
  return start;
}
export function assertPublished(value, id, ifcType) {
  check(value.status === 'published' && value.expressId === id, `published #${id}: ${JSON.stringify(value)}`);
  check(value.ifcType === ifcType, 'canonical IFC type');
  check(value.marker === 'PresentationObligationsUnmet', 'shape-only marker');
  check(value.parts.every(part => part.revisionLocalFaces.length === part.indices.length / 3 && part.faces?.triangles.length === part.indices.length / 3 && part.color === undefined && part.instanceKey === undefined), 'revision-local and persistent face partitions still index triangles');
  check(JSON.stringify(value.obligationsUnmet) === JSON.stringify([
    'MaterialLayers', 'IfcAppearance',
  ]), `remaining obligations: ${JSON.stringify(value.obligationsUnmet)}`);
  check(value.parts.length === 1, 'complete single-part product');
  const part = value.parts[0];
  check(part.positions instanceof Float64Array && part.positions.length === 9, 'f64 positions');
  check(part.indices instanceof Uint32Array && part.indices.length === 3, 'u32 indices');
  check(part.worldFromObject instanceof Float64Array && part.worldFromObject.length === 16, 'f64 column-major matrix');
  check(part.worldFromObject.every(Number.isFinite), 'finite placement');
  check(part.worldFromObject[15] === 1, 'affine placement');
  check(part.curved === false, 'linear authored profile');
  // M11-N adds a per-corner channel; source positions/indices and both face
  // partitions retain their original cardinalities. No vertex split in this API.
  check(part.normals instanceof Float64Array && part.normals.length === part.indices.length * 3,
    'world-space f64 normal for every corner');
  const point = index => Array.from(part.positions.slice(3 * index, 3 * index + 3));
  const vector = v => [0, 1, 2].map(i => part.worldFromObject[i] * v[0]
    + part.worldFromObject[i + 4] * v[1] + part.worldFromObject[i + 8] * v[2]);
  const [a, b, c] = Array.from(part.indices, point);
  const u = vector(b.map((v, i) => v - a[i])), v = vector(c.map((v, i) => v - a[i]));
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const winding = cross.map(value => value / Math.hypot(...cross));
  for (let i = 0; i < part.indices.length; i++) {
    const normal = Array.from(part.normals.slice(i * 3, i * 3 + 3));
    check(normal.every(Number.isFinite) && Math.abs(Math.hypot(...normal) - 1) <= 1e-12, 'finite unit corner normal');
    check(normal.every((value, axis) => Math.abs(value - winding[axis]) <= 1e-9), 'planar normal follows the world-space triangle winding');
  }
  check(!('code' in value), 'published/refused discriminant');
}
export function assertRefused(value, id, code) {
  check(value.status === 'refused' && value.expressId === id && value.code === code,
    `refused #${id} ${code}: ${JSON.stringify(value)}`);
  check(!('parts' in value) && !('obligationsUnmet' in value), 'atomic refusal exposes no partial product');
  if (code === 'kernel_failure') check(value.kernelStatus === 4, 'typed kernel status');
}
export async function assertPeers(start, count) {
  const { peers } = await loadModule('/retained-test/peer.mjs');
  const created = peers.slice(start);
  check(created.length === count, `expected ${count} workers, got ${created.length}`);
  for (const peer of created) {
    check(peer.qualified === true, 'each acquired peer qualified');
    check(peer.retired === true, 'completed run released its worker');
  }
}
