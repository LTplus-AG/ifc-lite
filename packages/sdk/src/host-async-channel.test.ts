/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation } from '@ifc-lite/mutations';
import { RoomLayoutCache, type RoomWallRect } from '@ifc-lite/create';
import { BimHost } from './host.js';
import { createRoomCommandBackend } from './store-room-command.js';
import { BroadcastTransport } from './transport/broadcast.js';
import { MessagePortTransport } from './transport/message-port.js';
import type { BimBackend, SdkRequest, Transport } from './types.js';

function gate() {
  let release: () => void = () => { throw new Error('Gate not initialized'); };
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}
function connect(backend: BimBackend, channel: 'broadcast' | 'port') {
  const host = new BimHost(backend);
  let transport: Transport;
  if (channel === 'broadcast') {
    const name = `6232-native-room-${crypto.randomUUID()}`;
    host.listenBroadcast(name);
    transport = new BroadcastTransport(name, { timeoutMs: 3000 });
  } else {
    const ports = new MessageChannel();
    host.acceptPort(ports.port1);
    transport = new MessagePortTransport(ports.port2, { timeoutMs: 3000 });
  }
  return { host, transport, close() { transport.close(); host.close(); } };
}
const request: SdkRequest = { id: 'room', namespace: 'store', method: 'roomCommand', args: ['m', 42, { action: 'query' }] };

for (const channel of ['broadcast', 'port'] as const) {
  it(`${channel} channel awaits delayed results and clones typed values instead of posting Promise (#6232)`, async () => {
    const wait = gate(), entered = gate();
    const backend = { store: { async roomCommand() { entered.release(); await wait.pending; return { indices: Uint32Array.of(1,2,3) }; } }, subscribe: () => () => {} } as unknown as BimBackend;
    const connection = connect(backend, channel);
    try {
      let settled = false;
      const result = connection.transport.send(request).then(response => { settled = true; return response; });
      await entered.pending;
      expect(settled).toBe(false);
      wait.release();
      expect(await result).toEqual({ id: 'room', result: { indices: Uint32Array.of(1,2,3) } });
    } finally { wait.release(); connection.close(); }
  });
  it(`${channel} channel returns delayed rejection as the same error envelope used by sync dispatch (#6232)`, async () => {
    const wait = gate(), entered = gate();
    const failure = new Error('Native Room preparation refused');
    const backend = { store: { async roomCommand() { entered.release(); await wait.pending; throw failure; } }, subscribe: () => () => {} } as unknown as BimBackend;
    const connection = connect(backend, channel);
    try {
      const result = connection.transport.send(request);
      await entered.pending;
      wait.release();
      expect(await result).toEqual({ id: 'room', error: { message: failure.message, stack: failure.stack } });
      expect(connection.host.dispatch({ ...request, method: 'unknown' }).error?.message).toMatch(/Unknown method/);
    } finally { wait.release(); connection.close(); }
  });
}

const wasm = new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
for (const channel of ['broadcast', 'port'] as const) it.skipIf(!existsSync(wasm))(`${channel} channel carries actual Bonsai/native Room candidates after awaited preparation (#6232)`, async () => {
  const runtime = await import('@ifc-lite/wasm');
  runtime.initSync({ module: readFileSync(wasm) });
  const bytes = readFileSync(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const mutationView = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, mutationView);
  const model = { modelId: 'm', store, editor, mutationView, ownerHistoryId: null };
  // Area-partition invariant: native wall rectangles enclose 4×3m on the
  // actual source storey, away from the Bonsai file's existing IfcSpace.
  const walls: RoomWallRect[] = [
    [[20,19.9],[24,19.9],[24,20.1],[20,20.1]], [[23.9,20],[24.1,20],[24.1,23],[23.9,23]],
    [[20,22.9],[24,22.9],[24,23.1],[20,23.1]], [[19.9,20],[20.1,20],[20.1,23],[19.9,23]],
  ].map(corners => ({ corners: corners as [number, number][], centreline: [corners[0] as [number, number], corners[1] as [number, number]], thickness: .2 }));
  const wait = gate(), entered = gate(), layouts = new RoomLayoutCache();
  const calls = { resolve: 0, prepare: 0, history: 0, record: 0 };
  const service = createRoomCommandBackend(() => { calls.resolve++; return model; }, async () => { calls.prepare++; entered.release(); await wait.pending; return { walls, factory: runtime.SpacePlateHandle }; }, {
    layouts, historyHead: () => { calls.history++; return mutationView.getMutations().map(m => m.id).join('|'); },
    record: (_id, write) => { calls.record++; return recordCompoundMutation(mutationView, draft => write({ ...model, mutationView: draft, editor: new StoreEditor(store, draft) })); },
  });
  const connection = connect({ store: service, subscribe: () => () => {} } as unknown as BimBackend, channel);
  try {
    const pending = connection.transport.send(request);
    await entered.pending;
    wait.release();
    const response = await pending;
    expect(response.error).toBeUndefined();
    const result = response.result as Awaited<ReturnType<typeof service.roomCommand>>;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].grossArea).toBeCloseTo(12);
    expect(result.created).toEqual([]);
    expect(mutationView.getNewEntities()).toEqual([]);
    // #6232 / #6758 review 4175802258: actual wire data must be refused
    // before resolver, history, cache, native preparation or IFC recording.
    const snapshot = () => structuredClone({
      calls, cache: layouts.version(), records: editor.getNewEntities(),
      journal: mutationView.getMutations(), next: mutationView.peekNextExpressId(),
      attributes: mutationView.getAttributeMutationsByEntity(), types: mutationView.getTypeMutations(),
      source: new Uint8Array(store.source),
    });
    const before = snapshot();
    for (const expressIds of ['1', [1.5], [NaN], [-1], [0], [Number.MAX_SAFE_INTEGER + 1], [null], new Array(1), [1, 1], []]) {
      const refused = await connection.transport.send({ ...request, args: ['m', 42, { action: 'update', expressIds }] });
      expect(refused.error?.message).toMatch(/^Room update requires 1\.\.10000 unique positive safe-integer rooms$/);
      expect(refused.result).toBeUndefined();
      expect(snapshot()).toEqual(before);
    }
    // A real native author/update following malformed requests proves that
    // validation does not poison the per-model running lock.
    const authored = await connection.transport.send({ ...request, args: ['m', 42, { action: 'auto' }] });
    expect(authored.error).toBeUndefined();
    const authoredResult = authored.result as Awaited<ReturnType<typeof service.roomCommand>>;
    expect(authoredResult.created).toHaveLength(1);
    const roomId = authoredResult.created[0].expressId;
    const updated = await connection.transport.send({ ...request, args: ['m', 42, { action: 'update', expressIds: [roomId] }] });
    expect(updated.error).toBeUndefined();
    expect(updated.result).toMatchObject({ updated: [{ modelId: 'm', expressId: roomId }] });
    const unsupported = await connection.transport.send({ ...request, args: ['m', 42, { action: 'update', expressIds: [1222] }] });
    expect(unsupported.error?.message).toMatch(/No selected room has a supported current face/);
  } finally { wait.release(); connection.close(); service.disposeRooms(); }
});
