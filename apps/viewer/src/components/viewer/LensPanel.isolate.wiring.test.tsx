/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clicking a rule row in the active lens isolates that rule's matches.
 * Driven by rendering `LensPanel` and clicking the row a user would click,
 * then reading the store, never by grepping the handler's source.
 *
 * The defect these cover: `handleIsolateRule` pushed the raw
 * `lensRuleEntityIds` into the shared isolation channel. The renderer resolves
 * `isolatedEntities` against MESH ids (viewportUtils' `buildRenderOptions` ->
 * `isolatedIds`), so a rule matching an `IfcElementAssembly` (whose geometry
 * hangs off its `IfcRelAggregates` parts, never off the assembly id itself)
 * isolated an id that owns no mesh and the viewport went blank. Same family as
 * #2531 (Viewport's resolver), #2660 (the advanced filter's "Isolate in 3D")
 * and #1133 (assemblies are renderable through their parts).
 *
 * The lens-specific hazard is the OWNERSHIP RECORD: `lensRuleIsolation` stores
 * the exact ids the panel pushed, and `releaseRuleIsolation` only clears the
 * channel when `ruleIsolationOwnsChannel` finds the channel still holding
 * exactly those ids. Recording the raw matches while pushing the expanded ones
 * makes the lens permanently disown its own isolation: the un-isolate click
 * leaves the model stuck. That is why the round-trip lives in its own test
 * rather than as a trailing assertion.
 *
 * No models are seeded on purpose: with `models` empty and `ifcDataStore` null
 * `useLens` returns before re-evaluating, so the seeded `lensRuleEntityIds`
 * survives and the click exercises the handler with known inputs.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { Lens } from '@/store/slices/lensSlice';
import { LensPanel } from './LensPanel.js';

/** Global ids, the space `lensRuleEntityIds` is already in. */
const ASSEMBLY = 4_000_042;
const PART_A = 4_000_101;
const PART_B = 4_000_102;
const WALL = 4_000_500;
/** An IfcSpace: real geometry, but a type hidden by default
 *  (TYPE_VISIBILITY_SEMANTIC_DEFAULTS), so it is absent from the filtered mesh
 *  list the resolver bounds-checks against and resolves to nothing. */
const HIDDEN_SPACE = 4_000_700;

const LENS: Lens = {
  id: 'lens-under-test',
  name: 'Test lens',
  rules: [
    {
      id: 'rule-assembly',
      name: 'Assemblies',
      enabled: true,
      criteria: { type: 'ifcType', ifcType: 'IfcElementAssembly' },
      action: 'colorize',
      color: '#ff0000',
    },
    {
      id: 'rule-wall',
      name: 'Walls',
      enabled: true,
      criteria: { type: 'ifcType', ifcType: 'IfcWall' },
      action: 'colorize',
      color: '#00ff00',
    },
    {
      // DIFFERENT criteria from rule-assembly, same matched entities: an
      // ordinary coincidence in a real model (every assembly here is precast).
      // Two rules landing on one id set is the only way the isolate toggle can
      // be reached by a rule switch; it does not depend on the resolution.
      id: 'rule-precast',
      name: 'Precast',
      enabled: true,
      criteria: { type: 'property', propertySet: 'Pset_ConcreteElementGeneral', propertyName: 'Precast', operator: 'equals', propertyValue: 'TRUE' },
      action: 'colorize',
      color: '#ffff00',
    },
    {
      // The mixed match: an ordinary lens over an attribute matches a wall, an
      // assembly and a space at once.
      id: 'rule-mixed',
      name: 'Level 1',
      enabled: true,
      criteria: { type: 'attribute', attributeName: 'Name', operator: 'contains', attributeValue: 'L1' },
      action: 'colorize',
      color: '#0000ff',
    },
  ],
};

let initialState: ReturnType<typeof useViewerStore.getState>;

function seedLens(options: {
  /** Viewport's aggregation resolver (#2531). Omitted = a renderer that has
   *  not registered its camera callbacks yet. */
  resolveHighlightIds?: (ids: number[]) => number[];
  /** Pre-existing hides, to prove the round-trip restores them untouched. */
  hiddenEntities?: Set<number>;
} = {}) {
  useViewerStore.setState({
    savedLenses: [LENS],
    activeLensId: LENS.id,
    lensRuleCounts: new Map([
      ['rule-assembly', 1], ['rule-wall', 1], ['rule-precast', 1], ['rule-mixed', 3],
    ]),
    lensRuleEntityIds: new Map([
      ['rule-assembly', [ASSEMBLY]],
      ['rule-wall', [WALL]],
      // The same matches as rule-assembly, reached by other criteria.
      // Deliberately a fresh array, not a shared reference.
      ['rule-precast', [ASSEMBLY]],
      ['rule-mixed', [WALL, ASSEMBLY, HIDDEN_SPACE]],
    ]),
    lensRuleIsolation: null,
    lensHiddenIds: new Set<number>(),
    lensAppliedHiddenIds: [],
    lensColorMap: new Map(),
    lensAutoColorLegend: [],
    hiddenEntities: options.hiddenEntities ?? new Set<number>(),
    isolatedEntities: null,
    // Empty federation: keeps `useLens` from recomputing lensRuleEntityIds.
    models: new Map(),
    activeModelId: null,
    ifcDataStore: null,
    cameraCallbacks: {
      ...(options.resolveHighlightIds ? { resolveHighlightIds: options.resolveHighlightIds } : {}),
    } as never,
  });
}

/** The legend row for `ruleName`, matched the way a user finds it: by the
 *  visible rule name on a clickable row. */
function ruleRow(container: HTMLElement, ruleName: string): HTMLElement {
  const rows = [...container.querySelectorAll<HTMLElement>('div[role="button"]')].filter(
    (el) => el.textContent?.includes(ruleName),
  );
  assert.equal(rows.length, 1, `expected exactly one clickable legend row for ${JSON.stringify(ruleName)}, found ${rows.length}`);
  return rows[0];
}

/**
 * A resolver with the real one's contract (`expandToGeometryBearingIds`):
 * geometry-bearing ids pass through untouched, the geometry-less assembly is
 * replaced by its parts and never by itself, and an id that is invisible to
 * the FILTERED mesh list the resolver bounds-checks against (a hidden-type
 * IfcSpace) comes back as nothing at all.
 */
const assemblyResolver = (ids: number[]) =>
  ids.flatMap((id) => {
    if (id === ASSEMBLY) return [PART_A, PART_B];
    if (id === HIDDEN_SPACE) return [];
    return [id];
  });

describe('LensPanel: isolating a rule resolves geometry-less assemblies to their parts', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState, true);
  });

  after(() => {
    useViewerStore.setState(initialState, true);
  });

  it('renders a clickable legend row per rule (guards the harness, not the feature)', () => {
    seedLens({ resolveHighlightIds: assemblyResolver });
    const container = render(<LensPanel onClose={() => {}} />);

    // A count of 0 renders the row un-clickable (RuleRow's `isEmpty`), which
    // would make every assertion below vacuously unreachable instead of red.
    assert.equal(container.querySelectorAll('div[role="button"]').length, 4);
  });

  it('isolates the assembly\'s geometry-bearing parts, not its bare id', () => {
    seedLens({ resolveHighlightIds: assemblyResolver });
    const container = render(<LensPanel onClose={() => {}} />);

    click(ruleRow(container, 'Assemblies'));

    // Append, not replace: the parts MUST be there (the bare assembly renders
    // nothing), and the matched id rides along free because an id with no mesh
    // never matches the renderer's whitelist anyway (#2680).
    assert.deepEqual(
      useViewerStore.getState().isolatedEntities,
      new Set([PART_A, PART_B, ASSEMBLY]),
      'the isolation set must hold the renderable parts; the bare assembly id alone renders nothing',
    );
  });

  it('records the ids it actually pushed, so the lens still owns the channel', () => {
    seedLens({ resolveHighlightIds: assemblyResolver });
    const container = render(<LensPanel onClose={() => {}} />);

    click(ruleRow(container, 'Assemblies'));

    const isolation = useViewerStore.getState().lensRuleIsolation;
    assert.ok(isolation, 'the lens must record its isolation');
    assert.equal(isolation.ruleId, 'rule-assembly');
    assert.deepEqual(
      [...isolation.entityIds].sort((a, b) => a - b),
      [ASSEMBLY, PART_A, PART_B],
      'the ownership record is compared set-wise against the channel by ruleIsolationOwnsChannel; recording the raw matches while pushing the expanded ones disowns the isolation',
    );
  });

  it('round-trips: clicking the isolated rule again restores the prior visibility exactly', () => {
    const userHidden = new Set([9_000_001]);
    seedLens({ resolveHighlightIds: assemblyResolver, hiddenEntities: userHidden });
    const container = render(<LensPanel onClose={() => {}} />);

    click(ruleRow(container, 'Assemblies'));
    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([PART_A, PART_B, ASSEMBLY]), 'precondition: the first click isolates');

    click(ruleRow(container, 'Assemblies'));

    const s = useViewerStore.getState();
    assert.equal(
      s.isolatedEntities,
      null,
      'the un-isolate click must clear the channel; a mismatched ownership record leaves the model stuck isolated',
    );
    assert.equal(s.lensRuleIsolation, null, 'the claim must drop with the isolation');
    assert.deepEqual(s.hiddenEntities, userHidden, 'the user\'s own hides must survive the round-trip untouched');
  });

  it('round-trips through lens deactivation too, not just the rule row', () => {
    seedLens({ resolveHighlightIds: assemblyResolver });
    const container = render(<LensPanel onClose={() => {}} />);

    click(ruleRow(container, 'Assemblies'));
    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([PART_A, PART_B, ASSEMBLY]), 'precondition: the click isolates');

    // Turning the lens off runs the same releaseRuleIsolation ownership check.
    const card = container.querySelector<HTMLElement>(`div[data-tour="lens-card-${LENS.id}"]`);
    assert.ok(card, 'the lens card must render');
    click(card);

    assert.equal(useViewerStore.getState().isolatedEntities, null, 'deactivating the lens must release its isolation');
    assert.equal(useViewerStore.getState().lensRuleIsolation, null);
  });

  it('leaves a geometry-bearing rule alone, so the fix does not broaden every isolation', () => {
    seedLens({ resolveHighlightIds: assemblyResolver });
    const container = render(<LensPanel onClose={() => {}} />);

    click(ruleRow(container, 'Walls'));

    assert.deepEqual(
      useViewerStore.getState().isolatedEntities,
      new Set([WALL]),
      'a rule whose matches already own meshes must isolate exactly those ids',
    );
    assert.deepEqual(useViewerStore.getState().lensRuleIsolation?.entityIds, [WALL]);
  });

  it('switches to a DIFFERENT rule matching the same entities without the toggle clearing the channel', () => {
    // `isolateEntities` is a same-set TOGGLE (visibilitySlice.ts, `isolateEntities`): fed
    // the ids the channel already holds it CLEARS. So switching from one rule
    // to another whose criteria differ but whose matches coincide un-isolated
    // the model, while the panel went on to record the new rule as the owner
    // of an isolation that no longer existed, leaving the next release with an
    // empty channel to disown.
    //
    // Scope, stated honestly: this is PRE-EXISTING and the resolution added in
    // this PR does not widen it. Appending the raw matches unconditionally
    // keeps an assembly rule ({assembly, ...parts}) and a parts rule
    // ({...parts}) distinguishable, so only genuinely coincident matches
    // collide -- which is why this fixture uses two rules that match the same
    // entity by different criteria rather than an assembly/parts pair.
    seedLens({ resolveHighlightIds: assemblyResolver });
    const container = render(<LensPanel onClose={() => {}} />);
    const expected = new Set([PART_A, PART_B, ASSEMBLY]);

    click(ruleRow(container, 'Assemblies'));
    assert.deepEqual(useViewerStore.getState().isolatedEntities, expected, 'precondition: the first rule isolates the set');
    assert.equal(useViewerStore.getState().lensRuleIsolation?.ruleId, 'rule-assembly');

    click(ruleRow(container, 'Precast'));

    const s = useViewerStore.getState();
    assert.deepEqual(
      s.isolatedEntities,
      expected,
      'switching rules must leave the model isolated over the set, not blank the channel via the toggle',
    );
    assert.equal(s.lensRuleIsolation?.ruleId, 'rule-precast', 'the new rule must be recorded as the owner');
    assert.deepEqual(
      [...(s.lensRuleIsolation?.entityIds ?? [])].sort((a, b) => a - b),
      [ASSEMBLY, PART_A, PART_B],
      'the record must hold the set actually in the channel',
    );

    // And the handover must leave the release path working: the new owner
    // still owns the channel, so its own re-click clears.
    click(ruleRow(container, 'Precast'));
    assert.equal(useViewerStore.getState().isolatedEntities, null, 'releasing the new owner must clear the channel');
    assert.equal(useViewerStore.getState().lensRuleIsolation, null);
  });

  it('keeps every matched id on a MIXED rule, where some resolve and some resolve to nothing', () => {
    // The hole replace semantics leaves (#2680): the resolver bounds-checks
    // against the type-visibility FILTERED mesh list, and
    // TYPE_VISIBILITY_SEMANTIC_DEFAULTS starts spaces/spatialZones/openings/
    // virtualElements OFF, so a rule matching a wall, an assembly AND a space
    // resolves the first two, comes back non-empty, and the space silently
    // vanishes from the isolation set. Nothing looks wrong at first (the space
    // is hidden anyway); it goes wrong when the user turns spaces back on with
    // the isolation still active and they stay hidden with no way to tell why.
    // Carrying a mesh-less id is free: it never matches the renderer whitelist.
    seedLens({ resolveHighlightIds: assemblyResolver });
    const container = render(<LensPanel onClose={() => {}} />);

    click(ruleRow(container, 'Level 1'));

    const s = useViewerStore.getState();
    assert.deepEqual(
      s.isolatedEntities,
      new Set([WALL, PART_A, PART_B, ASSEMBLY, HIDDEN_SPACE]),
      'a matched id that resolves to nothing must survive alongside the ones that resolved',
    );
    assert.deepEqual(
      [...(s.lensRuleIsolation?.entityIds ?? [])].sort((a, b) => a - b),
      [ASSEMBLY, PART_A, PART_B, WALL, HIDDEN_SPACE].sort((a, b) => a - b),
      'the ownership record must hold the same set that was pushed, or the release check disowns it',
    );
  });

  it('keeps the raw ids when the resolver returns nothing, rather than isolating an empty set', () => {
    // An assembly with neither geometry nor geometry-bearing parts resolves to
    // nothing at all (expandToGeometryBearingIds drops it). Isolating the empty
    // set would hide the ENTIRE model, strictly worse than the raw id.
    seedLens({ resolveHighlightIds: () => [] });
    const container = render(<LensPanel onClose={() => {}} />);

    click(ruleRow(container, 'Assemblies'));

    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([ASSEMBLY]));
    assert.deepEqual(useViewerStore.getState().lensRuleIsolation?.entityIds, [ASSEMBLY]);
  });

  it('keeps the raw ids when no renderer has registered a resolver yet', () => {
    seedLens();
    const container = render(<LensPanel onClose={() => {}} />);

    click(ruleRow(container, 'Assemblies'));

    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([ASSEMBLY]));
    // And that pre-resolution path must still round-trip.
    click(ruleRow(container, 'Assemblies'));
    assert.equal(useViewerStore.getState().isolatedEntities, null);
  });
});
