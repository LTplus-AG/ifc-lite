/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3620: selecting a member of an IfcElementAssembly gave no
 * indication of that relationship near the IfcClass label, and no way to
 * jump to the assembly itself. This pins the fix: a "Part of Assembly"
 * badge appears when the selected element is decomposed by an
 * IfcElementAssembly (via IfcRelAggregates), and clicking it selects the
 * assembly -- including when the assembly itself owns no geometry, which is
 * the normal case (its meshes hang off the aggregated parts, not the
 * assembly entity).
 *
 * Driven the way a user drives it: mount the real panel over a REAL parsed
 * store (the panel walks a `ModelQuery`, which a cast stub cannot satisfy --
 * AGENTS.md), click the badge, and read the store back.
 */

import '@/test/setup-dom.js';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { PropertiesPanel } from './PropertiesPanel.js';

const MODEL_ID = 'm1';
const ID_OFFSET = 1_000_000;

/**
 * `#50 Assembly A` decomposes into the two columns `#60`/`#61` via
 * IFCRELAGGREGATES -- and, like every IfcElementAssembly, carries no
 * IfcProductDefinitionShape of its own; only the columns render. `#42 Wall A`
 * is an ordinary element in no aggregation at all -- the control.
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
#50=IFCELEMENTASSEMBLY('0Assembly00000000050',$,'Assembly A',$,$,$,$,$,$,$);
#60=IFCCOLUMN('0Column0000000000060',$,'Column A',$,$,$,$,$,$);
#61=IFCCOLUMN('0Column0000000000061',$,'Column B',$,$,$,$,$,$);
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

let initialState: ReturnType<typeof useViewerStore.getState>;

async function seed(selectedExpressId: number): Promise<void> {
  const parsed = await parseMiniStore();
  useViewerStore.setState({
    models: new Map([[MODEL_ID, {
      id: MODEL_ID,
      name: MODEL_ID,
      ifcDataStore: parsed,
      // The assembly owns no geometry -- geometryResult stays null/empty for
      // every case here, including the ordinary-element control, so the
      // panel is never leaning on a mesh existing to do its job.
      geometryResult: null,
      visible: true,
      idOffset: ID_OFFSET,
      maxExpressId: 100_000,
      loadedAt: 1,
    }]]) as never,
    activeModelId: MODEL_ID,
    selectedEntity: { modelId: MODEL_ID, expressId: selectedExpressId },
    selectedEntityId: selectedExpressId + ID_OFFSET,
    selectedEntityIds: new Set<number>(),
  });
}

function assemblyBadge(container: HTMLElement): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>('button')]
    .find((b) => b.textContent?.includes('Part of Assembly')) ?? null;
}

describe('Properties panel -- "Part of Assembly" (#3620)', () => {
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

  it('shows a clickable badge naming the parent assembly for a member element', async () => {
    await seed(60); // Column A, a member of Assembly A
    const container = render(<PropertiesPanel />);

    const badge = assemblyBadge(container);
    assert.ok(badge, 'expected a "Part of Assembly" badge for an assembly member');
    assert.ok(badge!.textContent?.includes('Assembly A'), `badge should name the assembly, got: ${badge!.textContent}`);
  });

  it('selects the parent assembly -- geometry-less -- when the badge is clicked', async () => {
    await seed(60); // Column A
    const container = render(<PropertiesPanel />);

    click(assemblyBadge(container)!);

    const s = useViewerStore.getState();
    assert.equal(s.selectedEntity?.expressId, 50, 'selection must move to the assembly, not stay on the part');
    assert.equal(s.selectedEntity?.modelId, MODEL_ID);
  });

  it('re-renders on the assembly itself after the click -- no crash, no blank panel, though it owns no geometry', async () => {
    await seed(60);
    const container = render(<PropertiesPanel />);

    click(assemblyBadge(container)!);

    // The panel must now describe the assembly, proving it rendered a full
    // properties view for an entity with no mesh of its own.
    assert.ok(container.textContent?.includes('Assembly A'), 'panel should now show the assembly\'s own name');
    assert.ok(container.textContent?.includes('IfcElementAssembly'), 'panel should show the assembly\'s IfcClass');
  });

  it('control: an ordinary element in no assembly shows no badge, selection unaffected', async () => {
    await seed(42); // Wall A -- not in any IfcRelAggregates
    const container = render(<PropertiesPanel />);

    assert.equal(assemblyBadge(container), null, 'a plain wall must not get an assembly badge');
    assert.equal(useViewerStore.getState().selectedEntity?.expressId, 42);
  });
});
