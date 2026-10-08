/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { StepExporter } from '@ifc-lite/export';
import { InMemoryModelRegistry, type LoadedModel, type Logger } from './context.js';
import { loadIfcModel } from './loader.js';
import { MCPServer } from './server.js';
import { ToolRegistry } from './tools/types.js';
import { ResourceRegistry } from './resources/types.js';
import { PromptRegistry } from './prompts/types.js';
import { createDraft, disposeLayerWorkspace, getLayerWorkspace } from './tools/layer-store.js';

const wasm = new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const available = existsSync(wasm);
beforeAll(async () => {
  if (!available) { console.warn('Run pnpm build:wasm for real session cleanup controls'); return; }
  const runtime = await import('@ifc-lite/wasm');
  runtime.initSync({ module: readFileSync(wasm) });
});
afterEach(() => vi.restoreAllMocks());
const snapshot = (model: LoadedModel) => {
  const view = model.backend.ensureEditor().getMutationView();
  return structuredClone({ graph: Array.from(new StepExporter(model.store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content), records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() });
};

for (const fault of ['backend', 'workspace', 'both'] as const) {
  it.skipIf(!available)(`#6232 / #6759 detach releases both real native Room caches after ${fault} cleanup failure`, async () => {
    const registry = new InMemoryModelRegistry();
    const sample = fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
    for (const modelId of ['alpha', 'beta']) registry.add(await loadIfcModel(sample, { modelId }));
    const alpha = registry.get('alpha')!, beta = registry.get('beta')!;
    const sessionId = `#6232-detach-${fault}`;
    const draft = createDraft(getLayerWorkspace(sessionId), { base: null, baseFiles: [], intent: 'cleanup control', claims: [], rawClaims: [] });
    const workspaceError = new Error('Actual draft destroy listener failed');
    const destroyFault = () => { throw workspaceError; };
    if (fault !== 'backend') draft.doc.on('destroy', destroyFault);
    const logged: { message: string; data?: Record<string, unknown> }[] = [];
    const logger: Logger = { log(_level, message, data) { logged.push({ message, data }); } };
    const server = new MCPServer({ version: 'test', registry, sessionId, logger, tools: new ToolRegistry(), resources: new ResourceRegistry(), prompts: new PromptRegistry() });
    const sent: unknown[] = [];
    server.attach({ send(message) { sent.push(message); } });
    const process = vi.spyOn(GeometryProcessor.prototype, 'process'); // delegates the real native pipeline
    const backendError = new Error('First backend failed after actual native disposal');
    const disposeAlpha = alpha.backend.dispose.bind(alpha.backend);
    const first = vi.spyOn(alpha.backend, 'dispose').mockImplementation(() => { disposeAlpha(); if (fault !== 'workspace') throw backendError; });
    const second = vi.spyOn(beta.backend, 'dispose'); // delegates actual disposal
    const query = (model: LoadedModel) => model.bim.store.roomCommand(model.id, 42, { action: 'query' });
    try {
      const alphaCandidates = await query(alpha), betaCandidates = await query(beta);
      const before = [snapshot(alpha), snapshot(beta)];
      expect(process).toHaveBeenCalledTimes(2);
      expect(await query(beta)).toEqual(betaCandidates);
      expect(process).toHaveBeenCalledTimes(2);
      let failure: unknown;
      try { server.detach(); } catch (error) { failure = error; }
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      if (fault === 'both') {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({ errors: [workspaceError, backendError] });
      } else expect(failure).toBe(fault === 'workspace' ? workspaceError : backendError);
      expect(logged).toEqual([
        ...(fault !== 'backend' ? [{ message: `Session cleanup failed for layer workspace ${sessionId}`, data: { error: workspaceError.message } }] : []),
        ...(fault !== 'workspace' ? [{ message: 'Session cleanup failed for model alpha', data: { error: backendError.message } }] : []),
      ]);
      server.notifyToolsChanged();
      expect(sent).toEqual([]);
      // A subsequent actual query must re-mesh both models, proving their
      // prepared geometry was released rather than merely calling a mock.
      expect(await query(alpha)).toEqual(alphaCandidates);
      expect(await query(beta)).toEqual(betaCandidates);
      expect(process).toHaveBeenCalledTimes(4);
      expect([snapshot(alpha), snapshot(beta)]).toEqual(before);
    } finally {
      draft.doc.off('destroy', destroyFault);
      disposeLayerWorkspace(sessionId);
      first.mockRestore();
      for (const model of registry.list()) model.backend.dispose();
    }
  }, 30_000); // Two real IFC models, native cache warmup and post-disposal rebuild.
}
