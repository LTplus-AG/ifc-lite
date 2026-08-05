/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  computeLayerId,
  computeStackHash,
  createProvenanceManifest,
  getProvenance,
  setProvenance,
} from '@ifc-lite/ifcx';
import type { IfcxFile, IfcxNode, ProvenanceCheck } from '@ifc-lite/ifcx';
import { extractStackState } from '@ifc-lite/merge';
import type { MergeConflict } from '@ifc-lite/merge';
import { BrowserLayerStore } from './browser-store.js';
import {
  editedWithRemovals,
  executeMergeInto,
  previewMergeInto,
  refStackFiles,
  candidateLabel,
  requiredCheckStatus,
} from './merge.js';
import { RegistryError } from './registry-client.js';
import type { LayerRegistryClient, RegistryMergeOutcome } from './registry-client.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';

function publishable(
  data: IfcxNode[],
  intent: string,
  baseIds: string[] | null,
  checks: ProvenanceCheck[] = [],
): IfcxFile {
  const bare: IfcxFile = {
    header: { id: '', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: '2026-07-11T00:00:00Z' },
    imports: [],
    schemas: {},
    data,
  };
  const manifest = createProvenanceManifest({
    author: { kind: 'human', principal: 'alice' },
    intent,
    base: baseIds === null ? null : { kind: 'stack', id: computeStackHash(baseIds) },
    created: '2026-07-11T00:00:00Z',
    checks,
  });
  const withManifest = setProvenance(bare, manifest);
  const id = computeLayerId(withManifest);
  return { ...withManifest, header: { ...withManifest.header, id } };
}

describe('viewer merge orchestration over the local store (#1717 V3)', () => {
  it('preview surfaces the conflict; per-conflict resolutions complete the merge', async () => {
    const store = await BrowserLayerStore.open();
    const base = publishable(
      [{ path: 'wall-1', attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } }],
      'Base model',
      null,
    );
    store.storeLayer(base);
    const ours = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'Ours edit', [base.header.id]);
    store.storeLayer(ours);
    store.setRef('main', { layers: [base.header.id, ours.header.id] });
    const candidate = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'Raise to REI120', [
      base.header.id,
    ]);
    store.storeLayer(candidate);

    const target = { kind: 'local', refName: 'main' } as const;
    const preview = await previewMergeInto(target, store, candidate.header.id);
    assert.strictEqual(preview.status, 'preview');
    assert.strictEqual(preview.conflicts.length, 1);
    assert.strictEqual(preview.conflicts[0].componentKey, 'pset:Pset_FireSafety');

    const merged = await executeMergeInto(
      target,
      store,
      candidate.header.id,
      [{ path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'theirs' }],
      'louis',
    );
    assert.strictEqual(merged.status, 'merged');
    assert.ok(merged.mergeLayerId?.startsWith('blake3:'));

    const state = extractStackState(refStackFiles(store, 'main'));
    assert.strictEqual(state.get('wall-1')?.components.get('pset:Pset_FireSafety')?.[FIRE], 'REI120');
  });

  it('an unaddressed conflict refuses to merge', async () => {
    const store = await BrowserLayerStore.open();
    const base = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI60' } }], 'Base', null);
    store.storeLayer(base);
    const ours = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'Ours', [base.header.id]);
    store.storeLayer(ours);
    store.setRef('main', { layers: [base.header.id, ours.header.id] });
    const candidate = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'Theirs', [base.header.id]);
    store.storeLayer(candidate);

    const outcome = await executeMergeInto({ kind: 'local', refName: 'main' }, store, candidate.header.id, [], 'louis');
    assert.strictEqual(outcome.status, 'conflicts');
    assert.strictEqual(outcome.conflicts.length, 1);
  });

  it('a candidate declaring a base the ref never had is refused, with the declared base id surfaced in the reason', async () => {
    const store = await BrowserLayerStore.open();
    const base = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI60' } }], 'Base', null);
    store.storeLayer(base);
    store.setRef('main', { layers: [base.header.id] });
    const foreignLayer = publishable([{ path: 'x', attributes: {} }], 'Foreign', null);
    store.storeLayer(foreignLayer);
    const candidate = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }],
      'Declares a base the ref never had',
      [foreignLayer.header.id],
    );
    store.storeLayer(candidate);

    const outcome = await executeMergeInto({ kind: 'local', refName: 'main' }, store, candidate.header.id, [], 'louis');
    assert.strictEqual(outcome.status, 'unrelated-base');
    const declaredBaseId = computeStackHash([foreignLayer.header.id]);
    assert.strictEqual(outcome.reason, `declared base ${declaredBaseId} matches nothing on the ref`);
  });

  it('an edited resolution replaces the conflicting component with reviewer-typed attributes', async () => {
    const store = await BrowserLayerStore.open();
    const base = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI60' } }], 'Base', null);
    store.storeLayer(base);
    const ours = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'Ours', [base.header.id]);
    store.storeLayer(ours);
    store.setRef('main', { layers: [base.header.id, ours.header.id] });
    const candidate = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'Theirs', [base.header.id]);
    store.storeLayer(candidate);

    const merged = await executeMergeInto(
      { kind: 'local', refName: 'main' },
      store,
      candidate.header.id,
      [
        {
          path: 'wall-1',
          componentKey: 'pset:Pset_FireSafety',
          choice: 'edited',
          attributes: { [FIRE]: 'REI180' },
        },
      ],
      'louis',
    );
    assert.strictEqual(merged.status, 'merged');
    const state = extractStackState(refStackFiles(store, 'main'));
    assert.strictEqual(state.get('wall-1')?.components.get('pset:Pset_FireSafety')?.[FIRE], 'REI180');
    const manifest = getProvenance(store.loadLayer(merged.mergeLayerId ?? ''));
    assert.deepStrictEqual(manifest?.merge?.resolutions, [
      { entity: 'wall-1', choice: 'edited', componentKey: 'pset:Pset_FireSafety' },
    ]);
  });

  it('an edited resolution tombstones the keys the reviewer removed (LWW would resurrect them)', async () => {
    const EXIT = 'bsi::ifc::v5a::Pset_FireSafety::FireExit';
    const store = await BrowserLayerStore.open();
    const base = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI60', [EXIT]: 'EX-1' } }], 'Base', null);
    store.storeLayer(base);
    const ours = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'Ours', [base.header.id]);
    store.storeLayer(ours);
    store.setRef('main', { layers: [base.header.id, ours.header.id] });
    const candidate = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'Theirs', [base.header.id]);
    store.storeLayer(candidate);

    const preview = await previewMergeInto({ kind: 'local', refName: 'main' }, store, candidate.header.id);
    const conflict = preview.conflicts[0];
    // The reviewer's edited object keeps FIRE only — the helper must null
    // every union key they dropped so composition cannot resurrect it.
    const attributes = editedWithRemovals(conflict, { [FIRE]: 'REI180' });
    assert.strictEqual(attributes[FIRE], 'REI180');
    for (const [key, value] of Object.entries(attributes)) {
      if (key !== FIRE) assert.strictEqual(value, null, `expected null tombstone for ${key}`);
    }

    const merged = await executeMergeInto(
      { kind: 'local', refName: 'main' },
      store,
      candidate.header.id,
      [{ path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'edited', attributes }],
      'louis',
    );
    assert.strictEqual(merged.status, 'merged');
    const state = extractStackState(refStackFiles(store, 'main'));
    const component = state.get('wall-1')?.components.get('pset:Pset_FireSafety');
    assert.strictEqual(component?.[FIRE], 'REI180');
    assert.ok(!(EXIT in (component ?? {})) || component?.[EXIT] == null, 'removed key must not survive the merge');
  });

  it('scores required checks against the candidate and merges past a failure only with a waiver', async () => {
    const store = await BrowserLayerStore.open();
    const base = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI60' } }], 'Base', null);
    store.storeLayer(base);
    store.setRef('main', {
      layers: [base.header.id],
      policy: { requiredChecks: ['fire.ids', 'geometry.ids'] },
    });
    const candidate = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }],
      'Raise rating',
      [base.header.id],
      [
        // fire.ids has evidence, but it FAILED — distinct from having no
        // evidence at all; both must score as `passing: false`.
        { tool: '@ifc-lite/ids', spec: 'fire.ids', result: 'fail' },
        { tool: '@ifc-lite/ids', spec: 'geometry.ids', result: 'pass' },
      ],
    );
    store.storeLayer(candidate);
    const target = { kind: 'local', refName: 'main' } as const;

    // One required check failed its evidence, the other is satisfied.
    assert.deepStrictEqual(await requiredCheckStatus(target, store, candidate.header.id), [
      { spec: 'fire.ids', passing: false },
      { spec: 'geometry.ids', passing: true },
    ]);

    const refused = await executeMergeInto(target, store, candidate.header.id, [], 'louis');
    assert.strictEqual(refused.status, 'policy-failure');
    assert.match(refused.reason ?? '', /fire\.ids/);

    const merged = await executeMergeInto(target, store, candidate.header.id, [], 'louis', [
      { spec: 'fire.ids', reason: 'panel sign-off 2026-07-12' },
    ]);
    assert.strictEqual(merged.status, 'merged');
    // The waiver is durably recorded on the merge layer, with the resolver.
    const mergeManifest = getProvenance(store.loadLayer(merged.mergeLayerId ?? ''));
    assert.deepStrictEqual(mergeManifest?.merge?.waived_checks, [
      { spec: 'fire.ids', reason: 'panel sign-off 2026-07-12', waivedBy: 'louis' },
    ]);
  });

  it('candidateLabel prefers the manifest intent', async () => {
    const store = await BrowserLayerStore.open();
    const layer = publishable([{ path: 'a', attributes: { [FIRE]: 'X' } }], 'My intent line', null);
    store.storeLayer(layer);
    assert.strictEqual(candidateLabel(store, layer.header.id), 'My intent line');
    assert.strictEqual(candidateLabel(store, 'blake3:unknown-layer-id'), 'blake3:unknown-');
  });
});

/**
 * Minimal stand-in for LayerRegistryClient: previewMergeInto/executeMergeInto
 * only ever call pushLayer and mergeRef on a registry target, so those are
 * the only two methods a fake needs to honor.
 */
class FakeRegistryClient {
  mergeRefCalls: Array<{ name: string; init: unknown }> = [];
  constructor(
    private readonly pushLayerImpl: () => Promise<{ id: string }>,
    private readonly mergeRefImpl: (name: string, init: unknown) => Promise<RegistryMergeOutcome>,
  ) {}
  pushLayer(): Promise<{ id: string }> {
    return this.pushLayerImpl();
  }
  mergeRef(name: string, init: unknown): Promise<RegistryMergeOutcome> {
    this.mergeRefCalls.push({ name, init });
    return this.mergeRefImpl(name, init);
  }
}

describe('viewer merge orchestration over the registry backend (#1717 V3)', () => {
  it('preview prefers outcome.conflicts over plan.conflicts, and passes ancestorMatched/stats through', async () => {
    const store = await BrowserLayerStore.open();
    const candidate = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'Raise to REI120', null);
    store.storeLayer(candidate);

    const topLevelConflict = { componentKey: 'top-level' } as unknown as MergeConflict;
    const planConflict = { componentKey: 'from-plan' } as unknown as MergeConflict;
    const client = new FakeRegistryClient(
      async () => ({ id: candidate.header.id }),
      async () => ({
        status: 'preview',
        conflicts: [topLevelConflict],
        plan: { conflicts: [planConflict], stats: { autoMerged: 1, conflicting: 1 } },
        ancestor_matched: false,
      }),
    );

    const target = { kind: 'registry', refName: 'main', client: client as unknown as LayerRegistryClient } as const;
    const preview = await previewMergeInto(target, store, candidate.header.id);
    assert.strictEqual(preview.status, 'preview');
    // Top-level `conflicts` is the authoritative field; `plan.conflicts` is
    // only a fallback for outcomes that omit it.
    assert.deepStrictEqual(preview.conflicts, [topLevelConflict]);
    assert.strictEqual(preview.ancestorMatched, false);
    assert.deepStrictEqual(preview.stats, { autoMerged: 1, conflicting: 1 });
  });

  it('an idempotent 409 re-push is swallowed and the merge proceeds', async () => {
    const store = await BrowserLayerStore.open();
    const candidate = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'Raise', null);
    store.storeLayer(candidate);

    const client = new FakeRegistryClient(
      async () => {
        throw new RegistryError(409, 'already exists with identical canonical bytes');
      },
      async () => ({ status: 'merged', layers: ['a', 'b'], merge_layer: 'blake3:merged' }),
    );
    const target = { kind: 'registry', refName: 'main', client: client as unknown as LayerRegistryClient } as const;

    const merged = await executeMergeInto(target, store, candidate.header.id, [], 'louis');
    assert.strictEqual(merged.status, 'merged');
    assert.strictEqual(merged.mergeLayerId, 'blake3:merged');
    assert.strictEqual(client.mergeRefCalls.length, 1);
  });

  it('a non-409 push failure aborts the merge instead of being swallowed', async () => {
    const store = await BrowserLayerStore.open();
    const candidate = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'Raise', null);
    store.storeLayer(candidate);

    const client = new FakeRegistryClient(
      async () => {
        throw new RegistryError(500, 'registry unavailable');
      },
      async () => ({ status: 'merged', layers: ['a'], merge_layer: 'blake3:merged' }),
    );
    const target = { kind: 'registry', refName: 'main', client: client as unknown as LayerRegistryClient } as const;

    await assert.rejects(
      () => executeMergeInto(target, store, candidate.header.id, [], 'louis'),
      (err: unknown) => err instanceof RegistryError && err.status === 500,
    );
    // The push failure must short-circuit before any merge is attempted.
    assert.strictEqual(client.mergeRefCalls.length, 0);
  });
});
