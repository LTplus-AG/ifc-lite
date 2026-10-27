// SPDX-License-Identifier: MPL-2.0
// JS assertions on actual returned WASM values, not mock return objects.
import { peers, nextPeer } from '/smlib/peer.mjs';
function check(value, message) { if (!value) throw new Error(message); }
export async function preparePeer(failAt) {
  const start = peers.length;
  if (failAt) nextPeer().then(peer => {
    peer.failOpcode = 10;
    peer.failAtOccurrence = failAt;
    peer.kernelStatus = 4;
  });
  return start;
}
export function assertPublished(value, id) {
  check(value.status === 'published' && value.expressId === id, `published #${id}: ${JSON.stringify(value)}`);
  check(value.ifcType === 'IfcBuildingElementProxy', 'canonical IFC type');
  check(value.marker === 'PresentationObligationsUnmet', 'shape-only marker');
  check(JSON.stringify(value.obligationsUnmet) === JSON.stringify([
    'OpeningClosure', 'MaterialLayers', 'IfcAppearance', 'PersistentFaces',
  ]), `remaining obligations: ${JSON.stringify(value.obligationsUnmet)}`);
  check(value.parts.length === 1, 'complete single-part product');
  const part = value.parts[0];
  check(part.positions instanceof Float64Array && part.positions.length === 9, 'f64 positions');
  check(part.indices instanceof Uint32Array && part.indices.length === 3, 'u32 indices');
  check(part.worldFromObject instanceof Float64Array && part.worldFromObject.length === 16, 'f64 column-major matrix');
  check(part.worldFromObject.every(Number.isFinite), 'finite placement');
  check(part.worldFromObject[15] === 1, 'affine placement');
  check(part.curved === false, 'linear authored profile');
  check(!('code' in value), 'published/refused discriminant');
}
export function assertRefused(value, id, code) {
  check(value.status === 'refused' && value.expressId === id && value.code === code,
    `refused #${id} ${code}: ${JSON.stringify(value)}`);
  check(!('parts' in value) && !('obligationsUnmet' in value), 'atomic refusal exposes no partial product');
  if (code === 'kernel_failure') check(value.kernelStatus === 4, 'typed kernel status');
}
export async function assertPeers(start, count) {
  const created = peers.slice(start);
  check(created.length === count, `expected ${count} workers, got ${created.length}`);
  for (const peer of created) {
    check(peer.qualified === true, 'each acquired peer qualified');
    check(peer.retired === true, 'completed run released its worker');
  }
}
