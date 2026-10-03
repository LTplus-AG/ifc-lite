/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StepExporter } from '@ifc-lite/export';
import type { LoadedModel } from '../context.js';
import { createCopyContext, productStoreyOrigin } from '@ifc-lite/create';
import { describe, expect, it } from 'vitest';
import { liveToolSession as session } from '../test/live-tool-session.js';


// Pin only the exporter clock; the complete graph and header remain exact.
const exported = (model: LoadedModel | null) => model ? new StepExporter(model.store, model.backend.getMutationView() ?? undefined).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content : undefined;

describe('#6232 MCP paste/array parity', () => {
  for (const count of [1, 2]) for (const name of ['copy_elements', 'array_elements']) {
    it(`${name} carries real hosted geometry once and undoes the whole batch with ${count} models`, async () => {
      const { registry, call } = await session(count);
      const target = count === 1 ? 'alpha' : 'beta';
      const model = registry.get(target)!;
      const peer = count === 2 ? registry.get('alpha')! : null;
      const before = exported(model), peerBefore = exported(peer);
      const args = name === 'copy_elements' ? { transforms: [{ offset: [0, 5, 0] }] }
        : { params: { mode: 'linear', count: 3, anchor: [0, 0], cursor: [0, 1], distance: 5 } };
      const result = await call(name, { model_id: target, express_ids: [1222, 1262], ...args });
      expect(result.isError).not.toBe(true);
      const entities = result.structuredContent?.entities as { modelId: string; expressId: number }[];
      expect(entities).toHaveLength(name === 'copy_elements' ? 1 : 2);
      expect(entities.every(ref => ref.modelId === target)).toBe(true);
      const rows = model.backend.getMutationView()!.getNewEntities();
      expect(rows.filter(row => row.type === 'IfcRelVoidsElement')).toHaveLength(entities.length * 2);
      expect(rows.filter(row => row.type === 'IfcRelFillsElement')).toHaveLength(entities.length * 2);
      expect(exported(model)).not.toEqual(before);
      expect(exported(peer)).toEqual(peerBefore);
      expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
      expect(exported(model)).toEqual(before);
      expect(exported(peer)).toEqual(peerBefore);
    });
  }
  for (const count of [1, 2]) it(`duplicates the real hosted graph, preserves identity, and undoes with ${count} models`, async () => {
    const { registry, call } = await session(count);
    const target = count === 1 ? 'alpha' : 'beta';
    const model = registry.get(target)!;
    const peer = count === 2 ? registry.get('alpha')! : null;
    const before = exported(model), peerBefore = exported(peer);
    const context = () => createCopyContext(model.store, model.backend.ensureEditor());
    const source = context().read(1222)!;
    const origin = productStoreyOrigin(context(), 1222)!.origin;
    for (const Name of [undefined, 'Chosen duplicate']) {
      const result = await call('duplicate_element', { model_id: target, express_id: 1222, offset: [2, 3, 0], ...(Name ? { Name } : {}) });
      expect(result.isError).not.toBe(true);
      const entity = result.structuredContent?.entity as { modelId: string; expressId: number };
      expect(entity.modelId).toBe(target);
      const copied = context().read(entity.expressId)!;
      expect(copied.attributes[0]).not.toBe(source.attributes[0]);
      expect(copied.attributes[2]).toBe(Name ?? `${source.attributes[2]} (copy)`);
      expect(context().read(1222)!.attributes).toEqual(source.attributes);
      expect(productStoreyOrigin(context(), entity.expressId)!.origin).toEqual([origin[0] + 2, origin[1] + 3, origin[2]]);
      expect(context().voids.get(entity.expressId)).toHaveLength(2);
      for (const opening of context().voids.get(entity.expressId)!) expect(context().fills.get(opening.id)).toHaveLength(1);
      expect(exported(peer)).toEqual(peerBefore);
      expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
      expect(exported(model)).toEqual(before);
    }
    expect((await call('duplicate_element', { model_id: target, express_id: 1262, offset: [2, 0, 0] })).isError).toBe(true);
    expect(exported(model)).toEqual(before);
    expect(exported(peer)).toEqual(peerBefore);
  });
  it('refuses ambiguous routing, read-only access and late invalid copy without a graph change', async () => {
    const { registry, call } = await session(2);
    const before = exported(registry.get('beta')!);
    const args = { express_ids: [1222], transforms: [{ offset: [0, 5, 0] }] };
    expect((await call('copy_elements', args)).isError).toBe(true);
    expect((await call('copy_elements', { ...args, model_id: 'beta', express_ids: [1222, 999999] })).isError).toBe(true);
    expect(exported(registry.get('beta')!)).toEqual(before);
    expect((await call('duplicate_element', { express_id: 1222, offset: [1, 0, 0] })).isError).toBe(true);
    expect((await call('duplicate_element', { model_id: 'beta', express_id: 1222 })).isError).toBe(true);
    expect(exported(registry.get('beta')!)).toEqual(before);
    const readonly = await session(1, true);
    expect((await readonly.call('copy_elements', args)).isError).toBe(true);
    expect((await readonly.call('duplicate_element', { express_id: 1222, offset: [1, 0, 0] })).isError).toBe(true);
  });
});
