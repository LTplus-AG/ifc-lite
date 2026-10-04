/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { validateInput } from '../validate.js';
import { physicalEditTool } from './physical-edit.js';
import { liveToolSession } from '../test/live-tool-session.js';

// #6232 / review4172820355: discriminants, nested required fields and
// positive dimensions must be enforced by the actual advertised tool rules.
describe('physical operation input contract (#6232)', () => {
  for (const [operation, field] of [
    [{ kind: 'transform', express_ids: [1222], transform: { kind: 'move' } }, 'transform.delta'],
    [{ kind: 'transform', express_ids: [1222], transform: { kind: 'rotate', pivot: [0, 0] } }, 'transform.angle'],
    [{ kind: 'size', express_id: 1222, patch: { kind: 'slab' } }, 'patch.Thickness'],
    [{ kind: 'wall_endpoints', express_id: 1222, start: [0, 0, 0] }, 'operation.end'],
    [{ kind: 'split', requests: [{ expressId: 1222, cut: { kind: 'slab', a: [0, 0] } }] }, 'cut.b'],
    [{ kind: 'trim_extend', express_id: 1222, params: { mode: 'trim', click: [0, 0], boundary: { a: [1, 0], b: [1, 1] } } }, 'boundary.tMin'],
  ] as const) it(`reports the missing ${field}`, () => {
    const result = validateInput(physicalEditTool.inputSchema, { operation });
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.errors)).toContain(field);
  });

  it('accepts valid move and refuses an unknown discriminant, extras and nonpositive sizes', () => {
    const valid = { kind: 'transform', express_ids: [1222], transform: { kind: 'move', delta: [0, 1] } };
    expect(validateInput(physicalEditTool.inputSchema, { operation: valid }).valid).toBe(true);
    for (const operation of [
      { ...valid, kind: 'unknown' }, { ...valid, unexpected: 1 },
      { ...valid, transform: { ...valid.transform, delta: [1] } },
      ...[0, -1].map(Thickness => ({ kind: 'size', express_id: 1222, patch: { kind: 'slab', Thickness } })),
    ]) expect(validateInput(physicalEditTool.inputSchema, { operation }).valid).toBe(false);
    expect(validateInput(physicalEditTool.inputSchema, { operation: { kind: 'size', express_id: 1222, patch: { kind: 'slab', Thickness: .2 } } }).valid).toBe(true);
  });

  it('rejects malformed protocol input before any real IFC writer runs', async () => {
    const { registry, call } = await liveToolSession(1);
    const model = registry.get('alpha')!, view = model.backend.ensureEditor().getMutationView();
    const snapshot = () => ({ entities: view.getNewEntities(), mutations: view.getMutations(), next: view.peekNextExpressId() });
    const before = structuredClone(snapshot());
    const refused = await call('edit_element_geometry', { operation: { kind: 'transform', express_ids: [1222], transform: { kind: 'move' } } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent?.message).toBe('Input validation failed for edit_element_geometry');
    expect(JSON.stringify(refused.structuredContent?.details)).toContain('$.operation.transform.delta');
    expect(snapshot()).toEqual(before);
    expect((await call('edit_element_geometry', { operation: { kind: 'transform', express_ids: [1222], transform: { kind: 'move', delta: [0, 1] } } })).isError).not.toBe(true);
    expect(view.getMutations().length).toBeGreaterThan(before.mutations.length);
  });
});
