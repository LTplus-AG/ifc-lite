/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { resolveCapturedEntityScope, isCapturedEntityScope, type CapturedEntityScope } from './captured-scope.js';
import { evaluateFilterGroupsFederated } from './filter-evaluate-groups.js';

let store: IfcDataStore;
let contentHash: string;
const groups = [{ combinator: 'AND' as const, rules: [{ kind: 'ifcType' as const, op: 'in' as const, values: ['IfcWall', 'IfcWallStandardCase'] }] }];
let wallId: number;
const fingerprint = 'building-architecture.ifc:native-sample';
beforeAll(async () => {
  const bytes = readFileSync(new URL('../../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url));
  contentHash = createHash('sha256').update(bytes).digest('hex'); // This fixture host hashes every source byte.
  store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const walls = await evaluateFilterGroupsFederated([{ id: 'original', store }], groups, { limit: Infinity });
  expect(walls.length).toBeGreaterThan(1);
  wallId = walls[0].expressId;
});
const scopeFor = (expressId: number, creationId?: string): CapturedEntityScope => ({
  version: 1, mode: 'selected', capturedAt: 1,
  sources: [{ sourceFingerprint: fingerprint, sourceContentHash: contentHash, members: [{ expressId, ...(creationId ? { creationId } : {}) }] }],
});
const source = (id: string, mutationView?: MutablePropertyView) => ({ id, store, filterIdentity: fingerprint, sourceContentHash: contentHash, mutationView });

describe('#7186 captured native membership', () => {
  it('replays a real wall across model-id changes and explicitly empties foreign models', async () => {
    const models = [source('reloaded'), { ...source('foreign'), filterIdentity: 'foreign' }];
    const candidates = resolveCapturedEntityScope(scopeFor(wallId), models);
    expect([...candidates.get('foreign')!]).toEqual([]);
    const result = await evaluateFilterGroupsFederated(models, groups, { candidateExpressIdsByModel: candidates, limit: Infinity });
    expect(result.map(row => [row.modelId, row.expressId])).toEqual([['reloaded', wallId]]);
  });
  it('refuses missing, ambiguous, replaced-byte, deleted, and absent members before a run', () => {
    const scope = scopeFor(wallId);
    expect(() => resolveCapturedEntityScope(scope, [])).toThrow(/missing/);
    expect(() => resolveCapturedEntityScope(scope, [source('a'), source('b')])).toThrow(/ambiguous/);
    expect(() => resolveCapturedEntityScope(scope, [{ ...source('a'), sourceContentHash: 'replaced' }])).toThrow(/replaced/);
    expect(() => resolveCapturedEntityScope(scopeFor(999999), [source('a')])).toThrow(/member/);
    const view = new MutablePropertyView(store.properties, 'a');
    view.deleteEntity(wallId);
    expect(() => resolveCapturedEntityScope(scope, [source('a', view)])).toThrow(/member/);
  });
  it('keeps authored identity through edits and delete undo; refuses recovery without provenance and identical id reuse', () => {
    const view = new MutablePropertyView(store.properties, 'a');
    view.setExpressIdWatermark(100000);
    const entity = view.createEntity('IfcWall', ['known-guid', null, 'Authored wall']);
    const creation = view.getMutations().find(mutation => mutation.type === 'CREATE_ENTITY')!;
    const scope = scopeFor(entity.expressId, creation.id);
    view.setAttribute(entity.expressId, 'Name', 'Edited wall');
    expect(resolveCapturedEntityScope(scope, [source('a', view)]).get('a')?.has(entity.expressId)).toBe(true);
    const history = view.getMutations();
    view.deleteEntity(entity.expressId);
    expect(() => resolveCapturedEntityScope(scope, [source('a', view)])).toThrow(/member/);
    view.restoreNewEntity(entity);
    expect(resolveCapturedEntityScope(scope, [source('a', view)]).get('a')?.has(entity.expressId)).toBe(true);
    const recovered = new MutablePropertyView(store.properties, 'a');
    recovered.restoreNewEntity(structuredClone(entity));
    recovered.applyMutations(history);
    expect(() => resolveCapturedEntityScope(scope, [source('a', recovered)])).toThrow(/identity/);
    const reused = new MutablePropertyView(store.properties, 'a');
    reused.setExpressIdWatermark(100000);
    expect(reused.createEntity(entity.type, entity.attributes).expressId).toBe(entity.expressId);
    expect(() => resolveCapturedEntityScope(scope, [source('a', reused)])).toThrow(/identity/);
  });
  it('rejects duplicate identities, duplicate members, and oversized snapshots', () => {
    const scope = scopeFor(wallId);
    expect(isCapturedEntityScope(scope)).toBe(true);
    expect(isCapturedEntityScope({ ...scope, sources: [...scope.sources, ...scope.sources] })).toBe(false);
    expect(isCapturedEntityScope({ ...scope, sources: [{ ...scope.sources[0], members: [{ expressId: wallId }, { expressId: wallId }] }] })).toBe(false);
    expect(isCapturedEntityScope({ ...scope, sources: [{ ...scope.sources[0], members: Array.from({ length: 20001 }, (_, i) => ({ expressId: i + 1 })) }] })).toBe(false);
  });
});
