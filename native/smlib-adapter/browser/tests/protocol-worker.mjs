// SPDX-License-Identifier: MPL-2.0
// Inert transport peer, never geometry: echo opaque bytes or inject envelope
// faults selected by the third u32. Uses the browser protocol without additions.
self.onmessage = ({ data: { id, frames } }) => {
  const op = new DataView(frames[0]).getUint32(8, true);
  if (op === 90) { self.postMessage({ id, fatal: 'inert worker fault' }); self.close(); return; }
  if (op === 91) { self.close(); return; }
  if (op === 92) { self.postMessage({ id: id + 1000, frames }, frames); return; }
  if (op === 93) { self.postMessage({ id, frames: [new ArrayBuffer(11)] }); return; }
  if (op === 94) { self.postMessage({ id, frames: [new ArrayBuffer(4097)] }); return; }
  if (op === 95) { self.postMessage({ id, frames: [] }); return; }
  if (op === 96) { self.postMessage({ id, frames: [new Uint8Array(12)] }); return; }
  const reply = () => self.postMessage({ id, frames }, frames);
  if (op === 97) setTimeout(reply, 50);
  else reply();
};
