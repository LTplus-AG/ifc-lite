/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { StepExporter } from '@ifc-lite/export';
import { GeometryProcessor } from '@ifc-lite/geometry';
import type { LoadedModel } from '../context.js';
import type { CallToolResult } from '../protocol/index.js';
import { liveToolSession } from '../test/live-tool-session.js';

const wasm = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url), available = existsSync(wasm);
beforeAll(async () => {
  if (!available) { console.warn('Run pnpm build:wasm for real Room controls'); return; }
  const runtime = await import('@ifc-lite/wasm');
  runtime.initSync({ module: readFileSync(wasm) });
});
afterEach(() => vi.restoreAllMocks());
const snapshot = (model: LoadedModel) => {
  const mutations = model.backend.ensureEditor().getMutationView();
  return structuredClone({ graph: Array.from(new StepExporter(model.store, mutations).export({ schema:'IFC4', applyMutations:true, timeStamp:'2026-10-03T00:00:00' }).content), records: mutations.getNewEntities(), journal: mutations.getMutations(), next: mutations.peekNextExpressId() });
};

for (const count of [1,2]) it.skipIf(!available)(`#6232 read-only Room query uses native candidates and refuses every write action (${count} models)`, async () => {
  const { registry, call, transport } = await liveToolSession(count, true), target=count===1?'alpha':'beta', model = registry.get(target)!;
  const peer=registry.get('alpha') === model ? null : registry.get('alpha'), peerBefore=peer ? snapshot(peer) : null;
  try {
    const points: [number, number, number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
    for (const [i, Start] of points.entries()) model.bim.store.addWall(target, 42, { Start, End: points[(i+1)%4], Thickness:.2, Height:3 });
    const before = snapshot(model);
    const listed = await transport.send({ jsonrpc:'2.0', id:100, method:'tools/list' }) as { result:{ tools:Array<{name:string}> } };
    expect(listed.result.tools.some(tool => tool.name === 'query_rooms')).toBe(true);
    expect(listed.result.tools.some(tool => tool.name === 'room_command')).toBe(false);
    const query = await call('query_rooms', { model_id:target, storey_express_id:42 });
    expect(query.isError, JSON.stringify(query)).not.toBe(true);
    expect(query.structuredContent?.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ taken:false })]));
    for (const action of ['auto','pick','footprint','update','edit']) {
      const result = await call('room_command', { model_id:target, storey_express_id:42, command:{ action } });
      expect(result.structuredContent?.code).toBe('PERMISSION_DENIED');
    }
    expect((await call('query_rooms', { model_id:target, storey_express_id:42, settings:{ action:'auto' } })).structuredContent?.code).toBe('INVALID_INPUT');
    expect(snapshot(model)).toEqual(before);
    expect(peer ? snapshot(peer) : null).toEqual(peerBefore);
  } finally { for(const loaded of registry.list()) loaded.backend.dispose(); }
});

it.skipIf(!available)('#6232 repeated native Room query reuses preparation and invalidates after IFC edits', async () => {
  const { registry, call } = await liveToolSession(1), model = registry.get('alpha')!;
  const process = vi.spyOn(GeometryProcessor.prototype, 'process'); // delegates the actual native mesher
  try {
    const first = await call('room_command', { storey_express_id:42, command:{action:'query'} });
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    const before = snapshot(model);
    expect(await call('room_command', { storey_express_id:42, command:{action:'query'} })).toEqual(first);
    expect(process).toHaveBeenCalledTimes(1);
    expect(snapshot(model)).toEqual(before);
    model.bim.store.addWall('alpha', 42, { Start:[20,20,0],End:[24,20,0],Thickness:.2,Height:3 });
    expect((await call('room_command', { storey_express_id:42, command:{action:'query'} })).isError).not.toBe(true);
    expect(process).toHaveBeenCalledTimes(2);
  } finally { model.backend.dispose(); }
});

for (const fault of ['cancel','changed'] as const) it.skipIf(!available)(`#6232 native Room ${fault} has a distinct retryable public result`, async () => {
  const { registry, transport } = await liveToolSession(1), model = registry.get('alpha')!;
  let release!: () => void, started!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  const actual = GeometryProcessor.prototype.process;
  vi.spyOn(GeometryProcessor.prototype, 'process').mockImplementation(async function(this: GeometryProcessor, ...args: Parameters<GeometryProcessor['process']>) { started(); await barrier; return actual.apply(this,args); });
  try {
    const before = snapshot(model);
    const pending = transport.send({ jsonrpc:'2.0',id:901,method:'tools/call',params:{name:'room_command',arguments:{storey_express_id:42,command:{action:'query'}}} });
    await entered;
    if (fault === 'cancel') await transport.send({ jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:901} });
    else model.bim.store.addWall('alpha',42,{Start:[20,20,0],End:[24,20,0],Thickness:.2,Height:3});
    const expected = fault === 'cancel' ? before : snapshot(model);
    release();
    const result = (await pending as {result:CallToolResult}).result;
    expect(result.structuredContent?.code).toBe(fault === 'cancel' ? 'CANCELLED' : 'STATE_CHANGED');
    expect(result.structuredContent?.details).toEqual({ retryable:true });
    expect(snapshot(model)).toEqual(expected);
  } finally { release(); model.backend.dispose(); }
});

for (const command of ['room', 'align'] as const) it.skipIf(!available)(`#6232 unavailable native ${command} runtime remains a capability failure`, async () => {
  const { registry, call } = await liveToolSession(1), model = registry.get('alpha')!;
  vi.spyOn(GeometryProcessor.prototype,'init').mockRejectedValue(new Error('Native runtime unavailable (injected initialization fault)'));
  try {
    const column = command === 'align' ? model.bim.store.addColumn('alpha', 42, { Position:[20,20,0], Width:.2, Depth:.2, Height:3 }) : null;
    const before = snapshot(model);
    const result = column
      ? await call('edit_element_geometry', { operation:{kind:'align',reference_id:1222,express_ids:[column.expressId],mode:'left'} })
      : await call('room_command',{storey_express_id:42,command:{action:'query'}});
    expect(result.structuredContent?.code).toBe('UNSUPPORTED_OPERATION');
    expect(result.structuredContent?.details).toEqual({reason:'NATIVE_RUNTIME_UNAVAILABLE'});
    expect(snapshot(model)).toEqual(before);
  } finally { model.backend.dispose(); }
});
