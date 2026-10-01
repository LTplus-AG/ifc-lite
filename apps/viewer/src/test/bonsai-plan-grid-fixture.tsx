/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Real Bonsai parse, native-unit/frame variants, and mounted authored plan grid (#6232). */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { rectangularGridAxes } from '@ifc-lite/create';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { render, advance } from '@/test/render';
import { addGridIn } from '@/store/slices/mutation-curtain-grid';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { PlanView } from '@/components/viewer/plan/PlanView';

export const MODEL = 'bonsai', STOREY = 42;

interface FixtureOptions {
  millimetres?: boolean;
  rotatedStorey?: boolean;
  UTags?: string[];
  reload?: boolean;
}

export async function fixture(count: 1 | 2, options: FixtureOptions = {}) {
  await seedModelingSession(); // reset the shared session/undo state
  let source = readFileSync(new URL('../../public/samples/hello-wall.ifc', import.meta.url), 'utf8');
  // Explicit unit/frame variants of the real Bonsai source. The new grid is
  // authored in metres in either native-unit file and in the storey's frame.
  if (options.millimetres) source = source.replace('#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);');
  if (options.rotatedStorey) source = source
    .replace('#61=IFCCARTESIANPOINT((0.,0.,0.));', '#61=IFCCARTESIANPOINT((1000.,2000.,0.));')
    .replace('#63=IFCDIRECTION((1.,0.,0.));', '#63=IFCDIRECTION((0.,1.,0.));');
  const models = new Map(useViewerStore.getState().models);
  models.clear();
  const views = new Map<string, MutablePropertyView>();
  for (const [i, id] of [MODEL, 'peer'].slice(0, count).entries()) {
    const bytes = new TextEncoder().encode(source).buffer;
    const parsed = await new IfcParser().parseColumnar(bytes, { disableWorkerScan: true });
    // @raw-entity-enumeration-ok test fixture verifies one freshly parsed source storey before creating any mutation view
    assert.ok(parsed.entityIndex.byType.get('IFCBUILDINGSTOREY')?.includes(STOREY));
    const model = { ...fixtureModel(id, { idOffset: count === 1 ? 0 : (i + 1) * 1_000_000 }),
      ifcDataStore: parsed, geometryResult: useViewerStore.getState().geometryResult };
    models.set(id, model);
    views.set(id, new MutablePropertyView(parsed.properties ?? null, id));
  }
  const state = useViewerStore.getState();
  useViewerStore.setState({ models, activeModelId: MODEL, mutationViews: views,
    storeEditors: new Map(), modelPlacement: emptyPlacementState(), hostHiddenIfcTypes: null,
    typeVisibility: { ...state.typeVisibility, ifcGrid: true },
    hiddenEntities: new Set(), selectedEntityId: null, selectedEntityIds: new Set() });
  // Same source express ids in both models. The peer's tags and far-away grid
  // must never leak into the active plan's local frame.
  if (count === 2) {
    const peer = addGridIn(useViewerStore, 'peer', STOREY, {
      Position: [-50, -80, 0], ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4],
        UTags: ['peer-1', 'peer-2'], VTags: ['peer-A', 'peer-B'] }),
    });
    assert.ok('expressId' in peer);
  }
  const made = addGridIn(useViewerStore, MODEL, STOREY, {
    Position: [100, 200, 0], Direction: Math.PI / 2,
    ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4], UTags: options.UTags }), Name: 'Authored design grid',
  });
  assert.ok('expressId' in made);
  if (options.reload) {
    const model = models.get(MODEL)!;
    const exported = new StepExporter(model.ifcDataStore!, views.get(MODEL)).export({ schema: 'IFC4' });
    const loaded = await new IfcParser().parseColumnar(exported.content.slice().buffer, { disableWorkerScan: true });
    models.set(MODEL, { ...model, ifcDataStore: loaded });
    views.set(MODEL, new MutablePropertyView(loaded.properties ?? null, MODEL));
    useViewerStore.setState({ models: new Map(models), mutationViews: new Map(views), storeEditors: new Map() });
  }
  assert.ok(useViewerStore.getState().enterModelWorkspace({ modelId: MODEL, storeyId: STOREY }));
  const ui = render(<PlanView layout="split" />);
  await advance(450);
  return { ui, made };
}
