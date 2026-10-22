// SPDX-License-Identifier: MPL-2.0
// Protocol peer standing in for every /smlib/ module. It allocates handles and
// echoes frames; it never supplies geometry evidence or SDK qualification.
export const peers = [];
export const imports = [];
function handle(session, slot) {
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  view.setBigUint64(0, session, true); view.setUint32(8, slot, true); view.setUint32(12, 1, true);
  return bytes;
}
export class SmlibWorkerTransport {
  incarnation = Object.freeze({});
  objects = new Set();
  commands = [];
  slot = 0;
  session = 42n;
  meshInfo = [3, 1, 1, 0, 0, 0];
  constructor(options) { this.options = options; peers.push(this); imports.push('client'); }
  allocate() { const slot = ++this.slot; this.objects.add(slot); return handle(this.session, slot); }
  retire(token) { if (token === this.incarnation) { this.retired = true; this.incarnation = undefined; } }
  async batch(frames, token) {
    if (token !== this.incarnation || !token) throw new Error('stale worker incarnation');
    const owned = frames.map((frame) => structuredClone(frame, { transfer: [frame] }));
    if (this.hold) await this.hold;
    return owned.map((frame) => {
      const view = new DataView(frame), op = view.getUint32(8, true);
      this.commands.push({ op, slot: frame.byteLength >= 32 ? view.getUint32(28, true) : undefined });
      let bytes = new Uint8Array();
      if (op === 1) { bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, this.session, true); }
      else if (op === 8) { if (!this.objects.delete(view.getUint32(28, true))) throw new Error('fixture: unknown release'); }
      else if (op === 9) bytes = this.allocate();
      else if (op === 10) { bytes = new Uint8Array(24); this.meshInfo.forEach((n, i) => new DataView(bytes.buffer).setUint32(i * 4, n, true)); }
      else if (op === 11) {
        const stream = view.getUint32(36, true), count = view.getUint32(44, true);
        bytes = new Uint8Array(count * ([1, 4].includes(stream) ? 8 : 4)); // zeros: in-bounds indices
      } else throw new Error(`fixture: unexpected opcode ${op}`);
      const response = new Uint8Array(12 + bytes.length), envelope = new DataView(response.buffer);
      envelope.setUint32(0, 1, true);
      envelope.setUint32(4, this.wrongReply ? 0 : view.getUint32(4, true), true);
      response.set(bytes, 12);
      return response.buffer;
    });
  }
}
export async function uploadSweep(transport, session, recipe, declaration, incarnation) {
  imports.push('sweep');
  const peer = peers.find((candidate) => candidate.incarnation === incarnation);
  if (!peer || transport.incarnation !== incarnation) throw new Error('fixture: stale upload');
  peer.uploads = [...(peer.uploads ?? []), { session, declaration, bytes: Array.from(recipe) }];
  return { bytes: peer.allocate().buffer };
}
export async function runSweepContract(transport, incarnation) {
  imports.push('sweep-contract');
  const peer = peers.find((candidate) => candidate.incarnation === incarnation);
  if (peer.failQualification) throw new Error('fixture: witness failed');
  peer.qualified = true;
  return { regions: [], disks: [], evidence: 'protocol peer only' };
}
