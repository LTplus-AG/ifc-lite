/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { installLayout } from '@/test/dom-layout';
installLayout();
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { IfcParser, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import { createBimContext, type BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { LocalBackend } from '@/sdk/local-backend';
import { setLocale } from '@/i18n';
import { resolveEnglish } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { advance, cleanup, click, press, render, type as typeInto, waitFor, activate } from '@/test/render';
import { namedButton, destinationOption } from '@/test/palette-destinations';
import { publishPlacementGeorefContext } from '@/lib/geo/placement-georef-runtime';
import { leaveAlignmentMode } from '@/lib/section/alignment-controller';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice';
import { CommandPalette } from './CommandPalette';
import { PersistentToolHosts } from './PersistentToolHosts';
import { CesiumPlacementGizmo } from './placement/CesiumPlacementGizmo';
import { PlacementPanel } from './placement/PlacementPanel';
import { SectionToolbar } from './tools/SectionToolbar';
import { SectionHint } from './tools/SectionHint';
import { ViewportHud } from '@/components/viewport-ui/hud/ViewportHud';

// Parsed STEP invariant: one real wall identity and a projected coordinate operation.
// Empty geometry intentionally limits these cases to configuration/access, not GPU results.
const source = `ISO-10303-21;
HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);
#4=IFCAXIS2PLACEMENT3D(#5,$,$);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCMAPCONVERSION(#3,#8,500000.,5200000.,10.,1.,0.,1.);
#8=IFCPROJECTEDCRS('EPSG:32632',$,$,$,$,$,#2);
ENDSEC;END-ISO-10303-21;`;
const conversion: MapConversion = { id: 6, sourceCRS: 3, targetCRS: 8,
  eastings: 500000, northings: 5200000, orthogonalHeight: 10, scale: 1 };
const projected: ProjectedCRS = { id: 8, name: 'EPSG:32632', mapUnitScale: 1 };
const original = useViewerStore.getState();
let bim: BimContext;
beforeEach(async () => {
  setLocale('en'); localStorage.clear();
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
  const model = { ...fixtureModel('configuration'), ifcDataStore: data };
  useViewerStore.setState({ ...fixtureModels(model), collabRole: null, collabRoomId: null,
    loading: false, editEnabled: true, activeTool: 'select', selectedEntityId: null, selectedEntityIds: new Set(),
    mutationViews: new Map(), mutationVersion: 0, undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), georefMutations: new Map(),
    cesiumEnabled: false, cesiumAvailable: false, cesiumPlacementEditMode: false,
    cesiumPlacementDraft: null, cesiumPlacementDraftModelId: null, repositionOpen: false,
    sectionPlane: getDefaultSectionPlane(), inactiveSectionPlanes: [], sectionPickMode: false });
  bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
});
afterEach(() => {
  cleanup(); leaveAlignmentMode(); publishPlacementGeorefContext(null);
  useViewerStore.setState(original); localStorage.clear();
});
function Harness({ geo = false }: { geo?: boolean }) {
  const [open, setOpen] = useState(false);
  const panel = useViewerStore(s => s.sidebarActivePanel);
  const tool = useViewerStore(s => s.activeTool);
  return <BimReactContext.Provider value={bim}><PersistentToolHosts>
    <button onClick={() => setOpen(true)}>Commands</button>
    <CommandPalette open={open} onOpenChange={setOpen} />
    {geo && <CesiumPlacementGizmo modelId="configuration" mapConversion={conversion}
      baseMapConversion={conversion} projectedCRS={projected} />}
    {panel === 'placement' && <PlacementPanel />}
    <ViewportHud />
    {tool === 'section' && <><SectionToolbar /><SectionHint /></>}
  </PersistentToolHosts></BimReactContext.Provider>;
}
async function launch(id: string, query: string) {
  click(namedButton('Commands'));
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]'); assert.ok(input);
  typeInto(input, query); await advance(30);
  const row = destinationOption(id); assert.notEqual(row.getAttribute('aria-disabled'), 'true');
  click(row); await advance(60);
}
function topDialog() {
  const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
  assert.ok(dialog); return dialog;
}
function propertyInput() {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${resolveEnglish('dataConnector.targetPropertyHeader')}"]`);
  assert.ok(input); return input;
}
async function upload() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([
    'GlobalId,FireRating\n0aaaaaaaaaaaaaaaaaaaaa,EI60\n',
  ], 'configuration.csv', { type: 'text/csv' })] });
  act(() => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  await waitFor(() => Boolean(document.querySelector('input[aria-label="' + resolveEnglish('dataConnector.targetPropertyHeader') + '"]')),
    'real CSV parser creates the mapping row');
}
const rating = () => useViewerStore.getState().getMutationView('configuration')?.getPropertyValue(1, 'Pset_Access', 'FireRating');

test('#8947 palette CSV mapping reaches real Apply; review cancel preserves IFC before local commit', async () => {
  render(<Harness />); await launch('author:import-data', 'import data'); await upload();
  const pset = document.querySelector<HTMLInputElement>(`input[aria-label="${resolveEnglish('dataConnector.targetPsetHeader')}"]`);
  assert.ok(pset); typeInto(pset, 'Pset_Access');
  typeInto(propertyInput(), 'FireRating');
  click(namedButton('Review as changes')); await advance(0);
  let review = topDialog();
  assert.ok(!namedButton('Apply 1 change', review).disabled);
  assert.match(review.textContent ?? '', /Wall A/);
  assert.match(review.textContent ?? '', /EI60/);
  assert.equal(rating(), null, 'review has not written the parsed wall');
  press(review, 'Escape'); await advance(0);
  assert.equal(rating(), null, 'cancel writes nothing');
  assert.equal(propertyInput().value, 'FireRating', 'cancel returns to the actual mapping draft');
  click(namedButton('Review as changes')); await advance(0); review = topDialog();
  click(namedButton('Apply 1 change', review));
  await waitFor(() => rating() === 'EI60', 'canonical local commit applies the reviewed CSV');
  assert.match(review.textContent ?? '', /Applied 1 change/);
});

test('#8947 palette CSV incomplete mapping refuses review Apply and cancel keeps the editable draft', async () => {
  render(<Harness />); await launch('author:import-data', 'import data'); await upload();
  typeInto(propertyInput(), '');
  click(namedButton('Review as changes')); await advance(0);
  const review = topDialog();
  assert.ok(review.querySelector('[role="alert"]'), 'conversion explains invalid mapping');
  assert.equal([...review.querySelectorAll('button')].some(b => /^Apply \d/.test(b.textContent?.trim() ?? '') && !b.disabled), false);
  assert.equal(useViewerStore.getState().undoStacks.get('configuration')?.length ?? 0, 0);
  press(review, 'Escape'); await advance(0);
  assert.equal(propertyInput().value, '');
  assert.match(topDialog().textContent ?? '', /configuration.csv/);
});

test('#8947 palette projected georef nudge resets and cancels back to the authored anchor', async () => {
  render(<Harness geo />);
  // Projection resolution is asynchronous; wait for the real palette prerequisite.
  click(namedButton('Commands'));
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]'); assert.ok(input);
  typeInto(input, 'move georef');
  await waitFor(() => destinationOption('view:move-georef').getAttribute('aria-disabled') !== 'true', 'projected CRS resolves');
  click(destinationOption('view:move-georef')); await advance(60);
  await waitFor(() => Boolean(document.querySelector('[aria-label="Nudge east"]')), 'real docked editor');
  const body = document.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"]'); assert.ok(body);
  click(namedButton('Nudge east', body));
  assert.match(body.textContent ?? '', /500001\.00 m/);
  assert.equal(useViewerStore.getState().getGeorefMutations('configuration'), undefined);
  click(namedButton(resolveEnglish('cesiumGeo.placement.resetButton'), body));
  assert.match(body.textContent ?? '', /500000\.00 m/);
  click(namedButton('Nudge east', body));
  const toggle = body.querySelector('[role="switch"]'); assert.ok(toggle); click(toggle);
  assert.equal(document.querySelector('[aria-label="Nudge east"]'), null);
  assert.equal(useViewerStore.getState().getGeorefMutations('configuration'), undefined);
  click(toggle); await waitFor(() => Boolean(document.querySelector('[aria-label="Nudge east"]')), 'fresh draft opens');
  assert.match(body.textContent ?? '', /500000\.00 m/);
  assert.ok(namedButton(resolveEnglish('cesiumGeo.placement.applyButton'), body).disabled);
});

test('#8947 palette alignment model configuration refuses absent axes and closes without a cut', async () => {
  const axisSource = source.replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X1'))")
    .replace("#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);",
      "#1=IFCALIGNMENT('0aaaaaaaaaaaaaaaaaaaaa',$,'Road',$,$,$,$,$);");
  const axisData = await new IfcParser().parseColumnar(new TextEncoder().encode(axisSource).buffer, { disableWorkerScan: true });
  const wallModel = useViewerStore.getState().models.get('configuration'); assert.ok(wallModel);
  useViewerStore.setState(fixtureModels(wallModel, { ...fixtureModel('axis-owner'), ifcDataStore: axisData }));
  render(<Harness />); await launch('section-add:alignment', 'alignment');
  const row = document.querySelector<HTMLElement>('[data-testid="section-active-row"]'); assert.ok(row);
  const model = row.querySelector<HTMLElement>(`[aria-label="${resolveEnglish('alignmentSection.model')}"]`); assert.ok(model);
  activate(model); await advance(0);
  const choice = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(r => r.textContent?.trim() === 'axis-owner');
  assert.ok(choice); click(choice); await advance(0);
  const availableAxis = row.querySelector<HTMLElement>(`[aria-label="${resolveEnglish('alignmentSection.axis')}"]`); assert.ok(availableAxis);
  activate(availableAxis); await advance(0);
  const road = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(r => r.textContent?.trim() === 'Road');
  assert.ok(road, 'actual parsed IfcAlignment is offered by the chosen model');
  press(road, 'Escape'); await advance(0);
  // Cancel before selecting an axis: no evaluator/worker result is fabricated.
  activate(model); await advance(0);
  const walls = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(r => r.textContent?.trim() === 'configuration');
  assert.ok(walls); click(walls); await advance(0);
  const axis = row.querySelector<HTMLButtonElement>(`[aria-label="${resolveEnglish('alignmentSection.axis')}"]`); assert.ok(axis);
  assert.ok(axis.disabled, 'parsed wall-only model has no IfcAlignment');
  assert.match(axis.textContent ?? '', new RegExp(resolveEnglish('alignmentSection.noAxes')));
  click(axis); await advance(0);
  assert.equal(useViewerStore.getState().sectionPlane.custom?.alignment, undefined);
  const toolbar = document.querySelector<HTMLElement>('[data-testid="section-toolbar"]'); assert.ok(toolbar);
  click(namedButton(resolveEnglish('sectionTool.closeTitle'), toolbar)); await advance(0);
  assert.equal(document.querySelector('[data-testid="section-toolbar"]'), null);
  assert.equal(useViewerStore.getState().activeTool, 'select');
  assert.equal(useViewerStore.getState().sectionPlane.custom?.alignment, undefined);
});
