/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getProvenance, IFCLITE_ATTR } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { extractStackState } from '@ifc-lite/merge';
import type { ChangeSetOp, Mutation } from '@ifc-lite/mutations';
import { BrowserLayerStore } from './browser-store.js';
import { buildDeltaNodes, publishViewerDraft } from './publish.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';

function makeBase(): IfcxFile {
  return {
    header: {
      id: 'base-layer',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 't',
      timestamp: '2026-07-11T00:00:00Z',
    },
    imports: [],
    schemas: {},
    data: [
      {
        path: 'wall-guid-1',
        attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, [FIRE]: { type: 'IfcLabel', value: 'REI60' } },
      },
    ],
  };
}

function mutation(partial: Partial<Mutation>): Mutation {
  return {
    id: 'm1',
    type: 'UPDATE_PROPERTY',
    timestamp: 1,
    modelId: 'model-1',
    entityId: 7,
    ...partial,
  } as Mutation;
}

// Under node:test there is no indexedDB — the store runs memory-only,
// which exercises exactly the sync surface the merge engine consumes.
describe('publishViewerDraft (#1717 V2)', () => {
  it('freezes a property edit into a content-addressed, provenance-stamped layer on a ref', async () => {
    const store = await BrowserLayerStore.open();
    const base = makeBase();
    const result = publishViewerDraft({
      store,
      stackFiles: [base],
      mutations: [
        mutation({ psetName: 'Pset_FireSafety', propName: 'FireRating', newValue: 'REI90' }),
      ],
      pathOf: (id) => (id === 7 ? 'wall-guid-1' : undefined),
      intent: 'Raise fire rating',
      authorPrincipal: 'louis',
      refName: 'local',
      created: '2026-07-11T12:00:00Z',
    });

    assert.ok(result.layerId.startsWith('blake3:'));
    assert.deepStrictEqual(result.unresolved, []);
    assert.deepStrictEqual(store.getRef('local')?.layers, [result.layerId]);

    const stored = store.loadLayer(result.layerId);
    const manifest = getProvenance(stored);
    assert.strictEqual(manifest?.author.principal, 'louis');
    assert.strictEqual(manifest?.intent, 'Raise fire rating');
    assert.strictEqual(manifest?.base?.kind, 'stack');

    // The layer composes: the merge engine sees the new value on top.
    const state = extractStackState([base, stored]);
    const pset = state.get('wall-guid-1')?.components.get('pset:Pset_FireSafety');
    assert.deepStrictEqual(pset?.[FIRE], { type: 'IfcLabel', value: 'REI90' });
  });

  it('orders published nodes by path regardless of the mutation arrival order', async () => {
    const store = await BrowserLayerStore.open();
    const result = publishViewerDraft({
      store,
      stackFiles: [makeBase()],
      mutations: [
        mutation({ id: 'm1', entityId: 30, psetName: 'Pset_FireSafety', propName: 'FireRating', newValue: 'REI30' }),
        mutation({ id: 'm2', entityId: 10, psetName: 'Pset_FireSafety', propName: 'FireRating', newValue: 'REI10' }),
        mutation({ id: 'm3', entityId: 20, psetName: 'Pset_FireSafety', propName: 'FireRating', newValue: 'REI20' }),
      ],
      pathOf: (id) => ({ 30: 'zzz-guid', 10: 'aaa-guid', 20: 'mmm-guid' })[id],
      intent: 'Multi-entity edit',
      authorPrincipal: 'louis',
      refName: 'local',
      created: '2026-07-11T12:00:00Z',
    });
    assert.deepStrictEqual(
      result.file.data.map((n) => n.path),
      ['aaa-guid', 'mmm-guid', 'zzz-guid'],
    );
  });

  it('reports the specific unresolved entity ids when mixed with resolvable edits, not just an empty array', async () => {
    const store = await BrowserLayerStore.open();
    const result = publishViewerDraft({
      store,
      stackFiles: [makeBase()],
      mutations: [
        mutation({ id: 'm1', entityId: 7, psetName: 'Pset_FireSafety', propName: 'FireRating', newValue: 'REI90' }),
        mutation({ id: 'm2', entityId: 42, psetName: 'Pset_X', propName: 'A', newValue: 1 }),
      ],
      pathOf: (id) => (id === 7 ? 'wall-guid-1' : undefined),
      intent: 'Mixed resolution',
      authorPrincipal: 'louis',
      refName: 'local',
      created: '2026-07-11T12:00:00Z',
    });
    assert.deepStrictEqual(result.unresolved, [42]);
  });

  it('is deterministic: same edits, same created stamp, same content address', async () => {
    const store = await BrowserLayerStore.open();
    const init = {
      store,
      stackFiles: [makeBase()],
      mutations: [mutation({ psetName: 'Pset_FireSafety', propName: 'FireRating', newValue: 'REI90' })],
      pathOf: () => 'wall-guid-1',
      intent: 'Raise fire rating',
      authorPrincipal: 'louis',
      refName: 'local',
      created: '2026-07-11T12:00:00Z',
    };
    const a = publishViewerDraft(init);
    const b = publishViewerDraft(init); // idempotent re-store, ref gains the id twice
    assert.strictEqual(a.layerId, b.layerId);
  });

  it('reports unresolved entities and refuses an empty layer', async () => {
    const store = await BrowserLayerStore.open();
    assert.throws(
      () =>
        publishViewerDraft({
          store,
          stackFiles: [makeBase()],
          mutations: [mutation({ psetName: 'Pset_X', propName: 'A', newValue: 1, entityId: 99 })],
          pathOf: () => undefined,
          intent: 'Nothing resolvable',
          authorPrincipal: 'louis',
          refName: 'local',
        }),
      /No publishable changes/,
    );
  });

  it('property deletion and attribute edits serialize as removal opinions and prop keys', async () => {
    const store = await BrowserLayerStore.open();
    const result = publishViewerDraft({
      store,
      stackFiles: [makeBase()],
      mutations: [
        mutation({ id: 'm1', type: 'DELETE_PROPERTY', psetName: 'Pset_FireSafety', propName: 'FireRating' }),
        mutation({ id: 'm2', type: 'UPDATE_ATTRIBUTE', attributeName: 'Name', newValue: 'Wall W1' }),
      ],
      pathOf: () => 'wall-guid-1',
      intent: 'Cleanup',
      authorPrincipal: 'louis',
      refName: 'local',
      created: '2026-07-11T12:00:00Z',
    });
    const node = result.file.data.find((n) => n.path === 'wall-guid-1');
    assert.strictEqual(node?.attributes?.[FIRE], null);
    // Core attributes stay raw — the entity/hierarchy extractors only
    // honor a plain string here.
    assert.strictEqual(node?.attributes?.['bsi::ifc::prop::Name'], 'Wall W1');
    // Composition drops the removed member.
    const state = extractStackState([makeBase(), result.file]);
    assert.strictEqual(state.get('wall-guid-1')?.components.get('pset:Pset_FireSafety'), undefined);
  });

  it('a whole-pset deletion (DELETE_PROPERTY_SET) tombstones every member visible in the base state, not just the touched one', async () => {
    const EXIT = 'bsi::ifc::v5a::Pset_FireSafety::FireExit';
    const store = await BrowserLayerStore.open();
    const base: IfcxFile = {
      ...makeBase(),
      data: [
        {
          path: 'wall-guid-1',
          attributes: {
            'bsi::ifc::class': { code: 'IfcWall', uri: 'u' },
            [FIRE]: { type: 'IfcLabel', value: 'REI60' },
            [EXIT]: { type: 'IfcLabel', value: 'EX-1' },
          },
        },
      ],
    };
    const result = publishViewerDraft({
      store,
      stackFiles: [base],
      // Mixed with a non-tombstone op: buildDeltaNodes must still detect
      // that *some* op is a whole-component tombstone (not that *every*
      // op is), or the base-state lookup needed to resolve which keys to
      // null is skipped entirely.
      mutations: [
        mutation({ id: 'm1', type: 'DELETE_PROPERTY_SET', psetName: 'Pset_FireSafety' }),
        mutation({ id: 'm2', type: 'UPDATE_ATTRIBUTE', attributeName: 'Name', newValue: 'Wall W1' }),
      ],
      pathOf: (id) => (id === 7 ? 'wall-guid-1' : undefined),
      intent: 'Delete the whole fire-safety pset',
      authorPrincipal: 'louis',
      refName: 'local',
      created: '2026-07-11T12:00:00Z',
    });
    const node = result.file.data.find((n) => n.path === 'wall-guid-1');
    // Both base members must be nulled, not only the one a caller happens
    // to look at — a whole-component tombstone that only nulls a partial
    // set would let the rest shine back through composition.
    assert.strictEqual(node?.attributes?.[FIRE], null);
    assert.strictEqual(node?.attributes?.[EXIT], null);
    const state = extractStackState([base, result.file]);
    assert.strictEqual(state.get('wall-guid-1')?.components.get('pset:Pset_FireSafety'), undefined);
  });

  it('a whole-pset deletion on a CUSTOM-named set (not Pset_-prefixed) still tombstones its members', async () => {
    // `@ifc-lite/merge`'s `componentKeyForAttribute` used to classify
    // `bsi::ifc::v5a::<Set>::<Member>` by matching a literal "Pset_"/
    // "Qto_" substring in the key, not by looking at the value shape the
    // way `changeSetToOps` and `@ifc-lite/collab`'s inflation both do.
    // A set named anything else fell through to a one-off `attr:<key>`
    // bucket per member, so `buildDeltaNodes`'s `tombstone-component`
    // lookup (`baseState.get(entity).components.get('pset:<name>')`)
    // found nothing under that bucket and nulled zero attributes — a
    // "delete this property set" edit on a custom-named set silently did
    // nothing at all.
    const CUSTOM = 'bsi::ifc::v5a::CompanyDataSet::Owner';
    const store = await BrowserLayerStore.open();
    const base: IfcxFile = {
      ...makeBase(),
      data: [
        {
          path: 'wall-guid-1',
          attributes: {
            'bsi::ifc::class': { code: 'IfcWall', uri: 'u' },
            [CUSTOM]: { type: 'IfcLabel', value: 'Acme Co' },
          },
        },
      ],
    };
    const result = publishViewerDraft({
      store,
      stackFiles: [base],
      mutations: [
        mutation({ id: 'm1', type: 'DELETE_PROPERTY_SET', psetName: 'CompanyDataSet' }),
        mutation({ id: 'm2', type: 'UPDATE_ATTRIBUTE', attributeName: 'Name', newValue: 'Wall W1' }),
      ],
      pathOf: (id) => (id === 7 ? 'wall-guid-1' : undefined),
      intent: 'Delete the whole custom data set',
      authorPrincipal: 'louis',
      refName: 'local',
      created: '2026-07-11T12:00:00Z',
    });
    const node = result.file.data.find((n) => n.path === 'wall-guid-1');
    // The proven fix: the delta actually carries a null opinion for the
    // custom-named set's member, on the wire, instead of nothing at all.
    // Real IFCX composition (what the viewer renders) is per-attribute
    // LWW and doesn't consult `componentKeyForAttribute` at all, so this
    // null opinion alone is enough to make the property disappear for
    // the user.
    assert.strictEqual(node?.attributes?.[CUSTOM], null);
    // NOT yet fixed, and deliberately not asserted here: a `null` value
    // carries no type-shape to disambiguate a custom set name by, so
    // `@ifc-lite/merge`'s OWN semantic re-read of [base, delta] together
    // still buckets this null under `attr:<full key>` rather than
    // `pset:CompanyDataSet` (the docstring on `componentKeyForAttribute`
    // says so explicitly). That's a narrower, second-order gap in the
    // merge engine's conflict-detection model — worth a follow-up, but
    // out of scope here: the member-shape ambiguity is unresolvable
    // without carrying per-key bucket memory across the fold.
  });

  it('quantity op values wrap in a typed record unless they are plain finite numbers', () => {
    // Exercises buildDeltaNodes directly rather than through
    // publishViewerDraft: a non-finite quantity can never survive the
    // content-address hash further down the publish pipeline (blake3
    // canonicalization rejects Infinity/NaN outright), so the only way to
    // observe wireEntry's own finite-vs-typeof-number distinction is at
    // this layer, below where the hash gets computed.
    const ops: ChangeSetOp[] = [
      {
        op: 'set-component',
        entity: 'wall-guid-1',
        componentKey: 'qset:Qto_WallBaseQuantities',
        values: { Height: 3, Area: Number.POSITIVE_INFINITY },
      },
    ];
    const nodes = buildDeltaNodes(ops, []);
    const node = nodes.find((n) => n.path === 'wall-guid-1');
    const heightKey = 'bsi::ifc::v5a::Qto_WallBaseQuantities::Height';
    const areaKey = 'bsi::ifc::v5a::Qto_WallBaseQuantities::Area';
    // A plain finite number stays raw (inflation unwraps typed records
    // under Qto_* anyway)...
    assert.strictEqual(node?.attributes?.[heightKey], 3);
    // ...but a non-finite number is not "a plain finite number" — it must
    // still get the typed wrapper like any other non-numeric value, not
    // pass through raw where it would compose as literal Infinity.
    assert.deepStrictEqual(node?.attributes?.[areaKey], { type: 'IfcReal', value: Number.POSITIVE_INFINITY });
  });

  it('attr:class only serializes its "code" member; other members on that component must not leak into the class opinion', () => {
    const ops: ChangeSetOp[] = [
      {
        op: 'set-component',
        entity: 'wall-guid-1',
        componentKey: 'attr:class',
        values: { code: 'IfcColumn', uri: 'https://example.invalid/schema' },
      },
    ];
    const nodes = buildDeltaNodes(ops, []);
    const node = nodes.find((n) => n.path === 'wall-guid-1');
    // Only the class opinion, and it carries the entity type — a stray
    // "uri" member (or any other non-code member) is dropped, never
    // wrapped into `{code: <that member's value>}`.
    assert.deepStrictEqual(node?.attributes, { 'bsi::ifc::class': { code: 'IfcColumn' } });
  });

  it('an entity deletion publishes an explicit `true` tombstone opinion (not merely a truthy value)', async () => {
    const store = await BrowserLayerStore.open();
    const result = publishViewerDraft({
      store,
      stackFiles: [makeBase()],
      mutations: [mutation({ type: 'DELETE_ENTITY' })],
      pathOf: (id) => (id === 7 ? 'wall-guid-1' : undefined),
      intent: 'Remove wall',
      authorPrincipal: 'louis',
      refName: 'local',
      created: '2026-07-11T12:00:00Z',
    });
    const node = result.file.data.find((n) => n.path === 'wall-guid-1');
    // The composition-side tombstone check is a strict `=== true`
    // (packages/ifcx/src/tombstones.ts) — anything else silently keeps
    // the entity alive.
    assert.strictEqual(node?.attributes?.[IFCLITE_ATTR.DELETED], true);
  });

  it('add-entity ops stamp a class opinion only when an ifcType is known, and never fabricate one', () => {
    const withType: ChangeSetOp[] = [{ op: 'add-entity', entity: 'new-wall', ifcType: 'IfcWall' }];
    const withoutType: ChangeSetOp[] = [{ op: 'add-entity', entity: 'new-thing' }];

    const nodesWithType = buildDeltaNodes(withType, []);
    assert.deepStrictEqual(nodesWithType.find((n) => n.path === 'new-wall')?.attributes, {
      'bsi::ifc::class': { code: 'IfcWall' },
    });

    // No ifcType resolved: the node still surfaces (add-entity always
    // touches `node.attributes`, so the attribute-less-node filter does
    // not drop it), but it must carry no class opinion at all.
    const nodesWithoutType = buildDeltaNodes(withoutType, []);
    assert.deepStrictEqual(nodesWithoutType.find((n) => n.path === 'new-thing')?.attributes, {});
  });
});

describe('publishViewerDraft retype + skipped reporting (#1717 geometry pass)', () => {
  it('serializes a retype as a class opinion with PredefinedType on the core channel', async () => {
    const store = await BrowserLayerStore.open();
    const result = publishViewerDraft({
      store,
      stackFiles: [makeBase()],
      mutations: [
        mutation({ type: 'UPDATE_ENTITY_TYPE', entityType: 'IfcColumn', predefinedType: 'COLUMN' }),
      ],
      pathOf: (id) => (id === 7 ? 'wall-guid-1' : undefined),
      intent: 'Retype to column',
      authorPrincipal: 'alice',
      refName: 'local',
    });
    assert.strictEqual(result.skippedCount, 0);
    const node = result.file.data.find((n) => n.path === 'wall-guid-1');
    assert.deepStrictEqual(node?.attributes?.['bsi::ifc::class'], { code: 'IfcColumn' });
    assert.strictEqual(node?.attributes?.['bsi::ifc::prop::PredefinedType'], 'COLUMN');
  });

  it('reports edits with no layer representation instead of dropping them silently', async () => {
    const store = await BrowserLayerStore.open();
    const result = publishViewerDraft({
      store,
      stackFiles: [makeBase()],
      mutations: [
        mutation({ psetName: 'Pset_FireSafety', propName: 'FireRating', newValue: 'REI90' }),
        mutation({ id: 'm-future', type: 'SOME_FUTURE_TYPE' as Mutation['type'] }),
      ],
      pathOf: (id) => (id === 7 ? 'wall-guid-1' : undefined),
      intent: 'Mixed edits',
      authorPrincipal: 'alice',
      refName: 'local',
    });
    assert.strictEqual(result.skippedCount, 1);
    assert.strictEqual(result.opCount, 1);
  });

  it('reports an empty-pset creation as unrepresented instead of silently vanishing from the layer', async () => {
    // `changeSetToOps` materializes a whole-pset creation with no members
    // yet (`StoreEditor.addPropertySet(id, name, [])`, or any future
    // producer path that ends the same way) as `set-component` with
    // `values: {}` — see #2277's "materialize the (possibly empty) set"
    // fix on the producer side. The IFCX wire dialect has no attribute
    // that means "this pset exists with zero members", so `buildDeltaNodes`
    // cannot represent it; the regression is dropping it AND counting it
    // as published (`opCount`) with no diagnostic. Mixed with an unrelated
    // resolvable edit on a different entity so the batch isn't rejected
    // outright by the "every edit failed / was empty" guard.
    const store = await BrowserLayerStore.open();
    const result = publishViewerDraft({
      store,
      stackFiles: [makeBase()],
      mutations: [
        mutation({
          id: 'm-empty-pset',
          type: 'CREATE_PROPERTY_SET',
          entityId: 42,
          psetName: 'Pset_Empty',
          newValue: [],
        }),
        mutation({ id: 'm-real', entityId: 7, psetName: 'Pset_FireSafety', propName: 'FireRating', newValue: 'REI90' }),
      ],
      pathOf: (id) => (id === 7 ? 'wall-guid-1' : id === 42 ? 'wall-guid-empty' : undefined),
      intent: 'Create an empty pset alongside a real edit',
      authorPrincipal: 'alice',
      refName: 'local',
    });
    // The empty-pset op has no wire representation: it must be reported,
    // not silently folded into a successful opCount.
    assert.strictEqual(result.skippedCount, 1);
    // The entity that only carried the empty-pset op must not appear in
    // the published layer at all — there is nothing to compose there.
    assert.strictEqual(
      result.file.data.find((n) => n.path === 'wall-guid-empty'),
      undefined,
    );
    // The unrelated real edit on the other entity must still publish.
    const realNode = result.file.data.find((n) => n.path === 'wall-guid-1');
    assert.deepStrictEqual(realNode?.attributes?.[FIRE], { type: 'IfcLabel', value: 'REI90' });
  });
});

describe('BrowserLayerStore integrity', () => {
  it('refuses a header id that does not match the content address', async () => {
    const store = await BrowserLayerStore.open();
    const bogus = { ...makeBase(), header: { ...makeBase().header, id: 'blake3:not-really' } };
    assert.throws(() => store.storeLayer(bogus), /does not match content address/);
  });
});
