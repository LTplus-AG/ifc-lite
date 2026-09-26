/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5869: Home / Show all, read straight off the store at 1 and 3 federated
 * models. Each mechanism that keeps geometry off screen is switched on alone
 * (on the LAST model, so a reset that only looks at the first model is caught),
 * then Home runs, and the raw channel must be off unless the reset deliberately
 * keeps it. On main, Home left a hidden federated model hidden.
 *
 * Only store APIs that exist without the reason registry are used here, so the
 * behaviour is observed through `resetVisibilityForHomeFromStore` itself.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore, type ViewerState } from '@/store';
import { resetVisibilityForHomeFromStore } from '@/store/homeView';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';

const OFFSET = 1000;

interface Case {
  name: string;
  activate: (lastModelOffset: number) => Partial<ViewerState>;
  /** true when the mechanism still hides something. */
  active: (state: ViewerState) => boolean;
  /** Home keeps it on purpose (a preference or host config, not a view filter). */
  kept?: boolean;
}

const CASES: Case[] = [
  { name: 'manual hide', activate: (o) => ({ hiddenEntities: new Set([o + 1]) }), active: (s) => s.hiddenEntities.size > 0 },
  { name: 'isolation', activate: (o) => ({ isolatedEntities: new Set([o + 2]) }), active: (s) => s.isolatedEntities !== null },
  {
    // A lens rule-row click records its claim beside the channel; Home must drop
    // both, or the row still reads isolated and swallows the next click.
    name: 'lens rule isolation',
    activate: (o) => ({ isolatedEntities: new Set([o + 7]), lensRuleIsolation: { ruleId: 'walls', entityIds: [o + 7] } }),
    active: (s) => s.isolatedEntities !== null || s.lensRuleIsolation !== null,
  },
  { name: 'ghost', activate: (o) => ({ ghostExceptEntities: new Set([o + 3]) }), active: (s) => s.ghostExceptEntities !== null },
  { name: 'class filter', activate: (o) => ({ classFilter: { ids: new Set([o + 4]), label: 'IfcWall' } }), active: (s) => s.classFilter !== null },
  { name: 'storey filter', activate: (o) => ({ selectedStoreys: new Set([o + 5]) }), active: (s) => s.selectedStoreys.size > 0 },
  {
    name: 'hidden federated model',
    activate: () => {
      const models = new Map(useViewerStore.getState().models);
      const [lastId, last] = [...models].at(-1)!;
      models.set(lastId, { ...last, visible: false });
      return { models };
    },
    active: (s) => [...s.models.values()].some((m) => !m.visible),
  },
  {
    name: 'active lens hides',
    activate: (o) => ({ activeLensId: 'lens', lensHiddenIds: new Set([o + 6]), lensAppliedHiddenIds: [o + 6], hiddenEntities: new Set([o + 6]) }),
    active: (s) => s.hiddenEntities.has([...s.lensHiddenIds][0]!),
    kept: true,
  },
  { name: 'host hidden classes', activate: () => ({ hostHiddenIfcTypes: new Set(['IFCSPACE']) }), active: (s) => (s.hostHiddenIfcTypes?.size ?? 0) > 0, kept: true },
];

let initial: ViewerState;

beforeEach(() => {
  initial = useViewerStore.getState();
});

afterEach(() => {
  useViewerStore.setState(initial, true);
});

function seedModels(count: number): number {
  const models = Array.from({ length: count }, (_, i) => fixtureModel(`m${i}`, { idOffset: i * OFFSET }));
  useViewerStore.setState({
    ...fixtureModels(...models),
    hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null, classFilter: null,
    selectedStoreys: new Set(), lensRuleIsolation: null, activeLensId: null, lensHiddenIds: new Set(), lensAppliedHiddenIds: [],
    hostHiddenIfcTypes: null,
  });
  return (count - 1) * OFFSET;
}

for (const modelCount of [1, 3]) {
  describe(`Home at ${modelCount} federated model(s) (#5869)`, () => {
    for (const c of CASES) {
      it(`${c.kept ? 'keeps' : 'clears'} ${c.name}`, () => {
        const lastOffset = seedModels(modelCount);
        useViewerStore.setState(c.activate(lastOffset));
        assert.ok(c.active(useViewerStore.getState()), `precondition: ${c.name} is active`);

        resetVisibilityForHomeFromStore('home');
        assert.equal(c.active(useViewerStore.getState()), c.kept === true,
          c.kept ? `Home must keep ${c.name}` : `Home must clear ${c.name}`);
      });
    }
  });
}
