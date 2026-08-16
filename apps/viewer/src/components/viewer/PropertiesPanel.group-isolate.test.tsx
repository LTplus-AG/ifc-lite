/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Isolate this group's members in 3D" (the Focus button on a Relationships-card
 * group row, #1075) resolves geometry-less members to the parts that actually
 * render.
 *
 * An IfcElementAssembly carries no mesh of its own -- its geometry hangs off the
 * IfcRelAggregates parts -- and the renderer matches `isolatedEntities` against
 * mesh ids directly. So a group whose members are assemblies used to isolate a
 * set of ids that own no geometry, and the viewport went blank. #2531 fixed
 * that class for framing and the class/type trees, #2660 for the advanced
 * filter's "Isolate in 3D"; this file pins it for the Properties panel, the
 * sibling site #2660 left out of scope.
 *
 * Driven the way a user drives it: mount the real panel over a REAL parsed
 * store (the panel walks a `ModelQuery`, which a cast stub cannot satisfy --
 * AGENTS.md), click the group row's Focus button, and read the store back. No
 * assertion on the handler's source text and none on a control merely being
 * present: a Focus button wired to a handler nothing reaches renders exactly
 * the same.
 */

import '@/test/setup-dom.js';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { PropertiesPanel } from './PropertiesPanel.js';

const MODEL_ID = 'm1';
const ID_OFFSET = 1_000_000;

/**
 * Two zones over one model:
 *
 * - `#10 Zone A` holds exactly one member, the geometry-LESS assembly `#50`,
 *   whose meshes live on the aggregated columns `#60`/`#61`. Isolating its bare
 *   id renders nothing at all.
 * - `#20 Zone B` holds two ordinary geometry-bearing elements, the control that
 *   catches an over-broad expansion.
 * - `#30 Zone C` mixes the assembly with a hidden-by-default `IfcSpace`, the
 *   #1075 case: the resolver cannot see the space's mesh until this handler
 *   flips the spaces toggle, so a resolution that REPLACED the member ids
 *   would drop it.
 */
const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#42=IFCWALL('0Wall00000000000000042',$,'Wall A',$,$,$,$,$,$);
#43=IFCWALL('0Wall00000000000000043',$,'Wall B',$,$,$,$,$,$);
#50=IFCELEMENTASSEMBLY('0Assembly00000000050',$,'Assembly A',$,$,$,$,$,$,$);
#60=IFCCOLUMN('0Column0000000000060',$,'Column A',$,$,$,$,$,$);
#61=IFCCOLUMN('0Column0000000000061',$,'Column B',$,$,$,$,$,$);
#70=IFCSPACE('0Space00000000000070',$,'Space A',$,$,$,$,$,$,$);
#10=IFCZONE('0ZoneA00000000000010',$,'Zone A',$,$);
#20=IFCZONE('0ZoneB00000000000020',$,'Zone B',$,$);
#30=IFCZONE('0ZoneC00000000000030',$,'Zone C',$,$);
#11=IFCRELASSIGNSTOGROUP('0RelZoneA000000011',$,$,$,(#50),$,#10);
#21=IFCRELASSIGNSTOGROUP('0RelZoneB000000021',$,$,$,(#42,#43),$,#20);
#31=IFCRELASSIGNSTOGROUP('0RelZoneC000000031',$,$,$,(#70,#50),$,#30);
#51=IFCRELAGGREGATES('0RelAgg00000000051',$,$,$,#50,(#60,#61));
ENDSEC;
END-ISO-10303-21;
`;

let miniStore: Promise<IfcDataStore> | null = null;
function parseMiniStore(): Promise<IfcDataStore> {
  if (!miniStore) {
    const bytes = new TextEncoder().encode(MINI_IFC);
    miniStore = new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  }
  return miniStore;
}

const globalId = (expressId: number) => expressId + ID_OFFSET;

const ASSEMBLY = globalId(50);
const PART_A = globalId(60);
const PART_B = globalId(61);
const WALL_A = globalId(42);
const WALL_B = globalId(43);
const SPACE = globalId(70);

/**
 * Stand-in for the Viewport channel `#2531` registered
 * (`cameraCallbacks.resolveHighlightIds`, backed by `expandToGeometryBearingIds`):
 * a geometry-bearing id passes through untouched, a geometry-less one is
 * replaced by its geometry-bearing aggregated parts and never by itself.
 */
const resolveHighlightIds = (ids: number[]): number[] =>
  ids.flatMap((id) => (id === ASSEMBLY ? [PART_A, PART_B] : [id]));

let initialState: ReturnType<typeof useViewerStore.getState>;

async function seed(selectedExpressId: number, over: Record<string, unknown> = {}): Promise<void> {
  const parsed = await parseMiniStore();
  useViewerStore.setState({
    models: new Map([[MODEL_ID, {
      id: MODEL_ID,
      name: MODEL_ID,
      ifcDataStore: parsed,
      geometryResult: null,
      visible: true,
      idOffset: ID_OFFSET,
      maxExpressId: 100_000,
      loadedAt: 1,
    }]]) as never,
    activeModelId: MODEL_ID,
    selectedEntity: { modelId: MODEL_ID, expressId: selectedExpressId },
    selectedEntityId: globalId(selectedExpressId),
    selectedEntityIds: new Set<number>(),
    isolatedEntities: null,
    cameraCallbacks: { resolveHighlightIds } as never,
    ...over,
  });
}

/**
 * The Focus button on the named group's row in the Relationships card --
 * located by the title a user hovers plus the group name they read beside it,
 * the same two things they use. The assembly sits in two zones, so picking by
 * title alone would isolate an arbitrary one of them.
 */
function groupFocusButton(container: HTMLElement, groupName: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('button')]
    .filter((b) => b.getAttribute('title') === "Isolate this group's members in 3D")
    .filter((b) => b.parentElement?.textContent?.includes(groupName));
  assert.equal(found.length, 1, `expected exactly one isolate button for ${groupName}, found ${found.length}`);
  return found[0];
}

describe('Properties panel -- "Isolate this group\'s members in 3D"', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(async () => {
    // The handler frames the selection on a 50ms trailing timer; drain it here
    // so a later test does not collect this one's callback.
    await advance(60);
    cleanup();
    useViewerStore.setState(initialState, true);
  });

  after(() => {
    useViewerStore.setState(initialState, true);
  });

  it('isolates a geometry-less assembly member as its geometry-bearing parts, not its bare id', async () => {
    // Zone A's only member is the assembly. Before this fix the isolation set
    // was exactly {assembly} -- an id the renderer owns no mesh for, so the
    // viewport showed NOTHING while the panel reported a successful isolate.
    await seed(50);
    const container = render(<PropertiesPanel />);

    click(groupFocusButton(container, 'Zone A'));

    const s = useViewerStore.getState();
    assert.ok(
      s.isolatedEntities?.has(PART_A) && s.isolatedEntities?.has(PART_B),
      `the isolation set must carry the renderable parts; got ${[...(s.isolatedEntities ?? [])]}`,
    );
    assert.deepEqual(s.isolatedEntities, new Set([PART_A, PART_B, ASSEMBLY]));
    // The selection has to carry the parts too: the renderer highlights
    // `selectedEntityIds` directly (it does not expand assemblies itself), so
    // a selection of the bare assembly lights nothing up even once the parts
    // are the only thing left visible (#2531's selection/highlight finding).
    assert.deepEqual(s.selectedEntityIds, new Set([PART_A, PART_B, ASSEMBLY]));
  });

  it('keeps the group member as the primary selection; an expanded part must not steal selectedEntityId', async () => {
    // `setSelectedEntityIds` derives `selectedEntityId` from the array's LAST
    // element, and `useModelSelection` syncs `selectedEntity` off that -- so
    // members riding last is what keeps this panel on the element the user
    // clicked a group of, rather than on an arbitrary constituent column
    // (the #1133 convention, restated by #2660's review).
    await seed(50);
    const container = render(<PropertiesPanel />);

    click(groupFocusButton(container, 'Zone A'));

    assert.equal(
      useViewerStore.getState().selectedEntityId,
      ASSEMBLY,
      'the primary selection must stay a group member, not the last expanded part',
    );
  });

  it('leaves a group of ordinary geometry-bearing elements exactly as it was', async () => {
    // The control for the fix above: resolution must not broaden a group that
    // never needed it. Both walls own their meshes, so the resolver hands them
    // straight back and the isolated set is the two members and nothing else.
    await seed(42);
    const container = render(<PropertiesPanel />);

    click(groupFocusButton(container, 'Zone B'));

    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([WALL_A, WALL_B]));
  });

  it('un-isolates on a second press after an EXPANDED isolate, restoring the full model', async () => {
    // `isolateEntities` clears when handed the identical set
    // (visibilitySlice.ts), and this handler stores no record of what it
    // pushed -- the un-isolate press works only because the handler recomputes
    // the same set. Expansion must therefore be stable across presses: the
    // resolver reads the type-visibility-FILTERED mesh list, which the first
    // press can change.
    await seed(50);
    const container = render(<PropertiesPanel />);

    click(groupFocusButton(container, 'Zone A'));
    await advance(60);
    assert.deepEqual(
      useViewerStore.getState().isolatedEntities,
      new Set([PART_A, PART_B, ASSEMBLY]),
      'precondition: the first press isolated the EXPANDED set',
    );

    click(groupFocusButton(container, 'Zone A'));
    await advance(60);

    assert.equal(
      useViewerStore.getState().isolatedEntities,
      null,
      'the second press must clear isolation, or the model stays stuck isolated',
    );
  });

  it('keeps a hidden-by-default IfcSpace member that the resolver cannot see yet', async () => {
    // The real resolver checks bounds against the type-visibility-FILTERED
    // mesh list, so while spaces are hidden an IfcSpace member resolves to
    // NOTHING -- modelled here by a resolver that reads the same toggle. If
    // resolution REPLACED the member ids (as #2660's filter path does) the
    // space would be dropped from the isolation set and would still not render
    // after the toggle below flips it on, gutting the #1075 feature. It is
    // added to, so it survives.
    const visibilityAwareResolve = (ids: number[]): number[] =>
      ids.flatMap((id) => {
        if (id === SPACE) return useViewerStore.getState().typeVisibility.spaces ? [SPACE] : [];
        return id === ASSEMBLY ? [PART_A, PART_B] : [id];
      });
    await seed(70, {
      typeVisibility: { ...useViewerStore.getState().typeVisibility, spaces: false },
      cameraCallbacks: { resolveHighlightIds: visibilityAwareResolve } as never,
    });
    const container = render(<PropertiesPanel />);

    click(groupFocusButton(container, 'Zone C'));

    const s = useViewerStore.getState();
    assert.equal(s.typeVisibility.spaces, true, 'the space member\'s type gate must flip, or it renders nothing');
    assert.deepEqual(s.isolatedEntities, new Set([PART_A, PART_B, SPACE, ASSEMBLY]));
  });

  it('falls back to the bare member ids when the renderer has registered no resolver', async () => {
    // Pre-#2531 behaviour preserved for a renderer that has not initialised:
    // isolating an empty set would hide the ENTIRE model, which is strictly
    // worse than isolating an id that happens to own no mesh.
    await seed(50, { cameraCallbacks: {} as never });
    const container = render(<PropertiesPanel />);

    click(groupFocusButton(container, 'Zone A'));

    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([ASSEMBLY]));
  });
});
