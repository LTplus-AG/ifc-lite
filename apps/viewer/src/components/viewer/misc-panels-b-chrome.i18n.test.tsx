/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Combined i18n coverage for the #4918 grab-bag slice's remaining small
 * standalone files (`misc-panels-b.en.ts`) that don't already have their
 * own dedicated suite — `PointCloudPanel.i18n.test.tsx`,
 * `ShareDialog.i18n.test.tsx`, and `ModelTagRuleEditor.i18n.test.tsx`
 * cover those three separately. Each file below gets either a real render
 * (default English text, then a partial-locale override proving the
 * catalogue — not a hardcoded literal — drives the text) or, for the
 * handful of files whose translated text only ever appears behind a real
 * network round trip (`FederationSetupControls`'s match-review dialog),
 * or a heavy sibling panel body (`BottomStrip`'s `renderPanelBody`), a direct `resolve()`
 * assertion against the catalogue instead — the sweep's own bar for a
 * "truly trivial" file ("make sure every converted file has SOME test
 * coverage asserting its key(s) resolve").
 */
import '@/test/setup-dom.js';
import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { render, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { registerLocale, setLocale } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { PointCloudClasses } from './PointCloudClasses';
import { PointCloudLegend } from './PointCloudLegend';
import { FederationSetupControls } from './FederationSetupControls';
import { ShareScopeField } from './ShareScopeField';
import { LoadReportPanel } from './LoadReportPanel';
import { GeometryModeBanner } from './GeometryModeBanner';
import { CombinatorToggle, AddRuleMenu } from './FilterRuleControls';
import { GeometryAxisRow } from './GeometryAxisRow';
import type { ComponentType } from 'react';
import { ViewportHud } from '../viewport-ui/hud/ViewportHud';
import { TextAnnotationEditor } from './TextAnnotationEditor';
import { SaveMarkupToModelMenuItem } from './SaveMarkupToModelButton';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ExportChangesButton } from './ExportChangesButton';

const STORE_RESET = {
  models: new Map(),
  activeModelId: null,
  mutationViews: new Map(),
  mutationVersion: 0,
  georefMutations: new Map(),
  scheduleData: null,
  scheduleIsEdited: false,
  scheduleSourceModelId: null,
  ifcDataStore: null,
  pointCloudClassMask: undefined,
  pointCloudClassCounts: {},
  geometryModePendingReload: false,
  levelDisplayMode: 'stacked',
  activeStorey: null,
  explodedGap: 1,
} as Partial<ReturnType<typeof useViewerStore.getState>>;

afterEach(() => {
  cleanup();
  setLocale('en');
  act(() => {
    useViewerStore.setState(STORE_RESET);
  });
});

// ---- PointCloudClasses ----------------------------------------------------

it('PointCloudClasses: renders the empty-classification state in English and translates it (#4918)', () => {
  const container = render(<PointCloudClasses />);
  assert.ok(container.textContent?.includes('Classes'));
  assert.ok(container.textContent?.includes('No classification data in the loaded scans.'));

  registerLocale('pointcloudclasses-de', {
    'pointCloudClasses.emptyState': 'Keine Klassifizierungsdaten in den geladenen Scans.',
  });
  act(() => setLocale('pointcloudclasses-de'));
  assert.ok(container.textContent?.includes('Keine Klassifizierungsdaten in den geladenen Scans.'));
  // `summaryLabel` is not in the partial locale: must still fall back.
  assert.ok(container.textContent?.includes('Classes'));
});

// ---- PointCloudLegend ------------------------------------------------------

it('PointCloudLegend: renders the intensity ramp labels in English and translates the heading (#4918)', () => {
  const container = render(<PointCloudLegend colorMode="intensity" />);
  assert.ok(container.textContent?.includes('Intensity'));
  assert.ok(container.textContent?.includes('low'));
  assert.ok(container.textContent?.includes('high'));

  registerLocale('pointcloudlegend-de', { 'pointCloudLegend.intensityLabel': 'Intensität' });
  act(() => setLocale('pointcloudlegend-de'));
  assert.ok(container.textContent?.includes('Intensität'));
  assert.ok(container.textContent?.includes('low'));
});

// ---- FederationSetupControls ------------------------------------------------
// The match-review dialog only opens after a real two-file selection round
// trip through `parseFederationSetupFile`/`matchFederationSetup` — not worth
// faking a federation-setup JSON fixture just to read its own labels back.
// Mount for a smoke check (no crash with the two hidden file inputs), and
// assert the catalogue values directly for the labels that dialog renders.

it('FederationSetupControls: mounts without a dialog open, and its catalogue values resolve (#4918)', () => {
  const container = render(<FederationSetupControls />);
  assert.equal(container.querySelectorAll('[role="dialog"]').length, 0);
  assert.equal(resolve('federationSetupControls.reopenTitle'), 'Reopen federation setup');
  assert.equal(
    resolve('federationSetupControls.reopenDescription'),
    'Review how each saved model slot matched your local files before restoring.',
  );
  assert.equal(resolve('federationSetupControls.cancel'), 'Cancel');
  assert.equal(resolve('federationSetupControls.restoringButton'), 'Restoring…');
  assert.equal(resolve('federationSetupControls.restoreButton'), 'Restore federation');
  assert.equal(resolve('federationSetupControls.confidence.content'), 'Matched');
  assert.equal(resolve('federationSetupControls.confidence.nameSize'), 'Matched (by name)');
  assert.equal(resolve('federationSetupControls.confidence.nameOnly'), 'Same name, different file');
  assert.equal(resolve('federationSetupControls.confidence.none'), 'Missing');
});

// ---- ShareScopeField --------------------------------------------------------

it('ShareScopeField: renders the multi-model caption in English and translates it (#4918)', () => {
  const container = render(
    <ShareScopeField
      showScope
      scope="all"
      onScopeChange={() => {}}
      editable
      onConfirm={() => {}}
      loadedCount={3}
      seedableCount={3}
      activeModelName="Tower.ifc"
      roomModelCount={null}
    />,
  );
  assert.ok(container.textContent?.includes('Share'));
  assert.ok(container.textContent?.includes('Active model only'));
  assert.ok(container.textContent?.includes('All 3 loaded models'));
  assert.ok(container.textContent?.includes('Every loaded model is shared as its own model, so recipients see the whole workspace.'));
  assert.ok(container.textContent?.includes('Create link'));
  assert.ok(container.textContent?.includes('Creating the link uploads the shared model data to the collaboration server'));

  registerLocale('sharescopefield-de', { 'shareScopeField.createLink': 'Link erstellen' });
  act(() => setLocale('sharescopefield-de'));
  assert.ok(container.textContent?.includes('Link erstellen'));
});

// ---- LoadReportPanel --------------------------------------------------------

it('LoadReportPanel: renders the no-models English state and translates it (#4918)', () => {
  const container = render(<LoadReportPanel onClose={() => {}} />);
  assert.ok(container.textContent?.includes('Load report'));
  assert.ok(container.textContent?.includes('No models loaded.'));
  const exportBtn = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Export JSON');
  assert.ok(exportBtn);
  const closeBtn = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Close');
  assert.ok(closeBtn);

  registerLocale('loadreportpanel-de', { 'loadReportPanel.noModelsLoaded': 'Keine Modelle geladen.' });
  act(() => setLocale('loadreportpanel-de'));
  assert.ok(container.textContent?.includes('Keine Modelle geladen.'));
  assert.ok(container.textContent?.includes('Load report'));
});

it('LoadReportPanel: the per-row entity summary and status labels resolve from the catalogue (#4918)', () => {
  assert.equal(
    resolve('loadReportPanel.entitySummary', { productId: 7, ifcType: 'IfcWall', csgFailures: 1, openings: 2 }),
    '#7 IfcWall — 1 failure(s), 2 opening(s)',
  );
  assert.equal(resolve('loadReportPanel.tierSuffix', { tier: 2 }), ' · tier 2');
  assert.equal(resolve('loadReportPanel.fastModeSuffix'), ' · fast mode');
  assert.equal(resolve('loadReportPanel.status.unavailable'), 'Diagnostics unavailable');
  assert.equal(resolve('loadReportPanel.status.clean'), 'Clean');
  assert.equal(resolve('loadReportPanel.status.issuesFound'), 'Issues found');
});

// ---- GeometryModeBanner ------------------------------------------------------

it('GeometryModeBanner: renders the fast-mode banner in English and translates it (#4918)', () => {
  act(() => {
    useViewerStore.setState({
      geometryModePendingReload: true,
      geometryMode: 'fast',
      geometryReloadReason: 'mode',
    });
  });
  // `GeometryModeBanner` portals into `ViewportHud`'s top-center region
  // (#5504); mount the HUD host alongside it, or `HudItem` renders nothing.
  const container = render(<><ViewportHud /><GeometryModeBanner /></>);
  assert.ok(container.textContent?.includes('Fast geometry enabled'));
  assert.ok(container.textContent?.includes('Reload model to apply the new setting.'));
  const reloadButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Reload'));
  assert.ok(reloadButton);

  registerLocale('geometrymodebanner-de', { 'geometryModeBanner.fastEnabled': 'Schnelle Geometrie aktiviert' });
  act(() => setLocale('geometrymodebanner-de'));
  assert.ok(container.textContent?.includes('Schnelle Geometrie aktiviert'));
  assert.ok(container.textContent?.includes('Reload model to apply the new setting.'));
});

// ---- FilterRuleControls ------------------------------------------------------

it('FilterRuleControls: CombinatorToggle title and AddRuleMenu body render in English and translate (#4918)', () => {
  const container = render(<CombinatorToggle value="AND" onChange={() => {}} />);
  const toggle = container.querySelector('[title]');
  assert.equal(toggle?.getAttribute('title'), 'AND requires every rule to match. OR matches any rule.');

  const menuContainer = render(<AddRuleMenu onAdd={() => {}} />);
  assert.ok(menuContainer.textContent?.includes('Add rule'));
  const trigger = menuContainer.querySelector('button')!;
  act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
  assert.ok(document.body.textContent?.includes('Filter dimension'));

  registerLocale('filterrulecontrols-de', { 'filterRuleControls.addRuleDefaultLabel': 'Regel hinzufügen' });
  act(() => setLocale('filterrulecontrols-de'));
  assert.ok(menuContainer.textContent?.includes('Regel hinzufügen'));
});

// ---- GeometryAxisRow ----------------------------------------------------------

it('GeometryAxisRow: renders decrease/increase aria-labels in English and translates them (#4918)', () => {
  const container = render(
    <GeometryAxisRow label="X" value="1" onChange={() => {}} onNudgeMinus={() => {}} onNudgePlus={() => {}} />,
  );
  assert.ok(container.querySelector('[aria-label="Decrease X"]'));
  assert.ok(container.querySelector('[aria-label="Increase X"]'));

  registerLocale('geometryaxisrow-de', { 'geometryAxisRow.decreaseAriaLabel': '{label} verringern' });
  act(() => setLocale('geometryaxisrow-de'));
  assert.ok(container.querySelector('[aria-label="X verringern"]'));
});

// ---- VisibilityChips -----------------------------------------------------------

it('VisibilityChips: renders the exploded/solo labels in English and translates them (#5882)', async () => {
  // Reverting #5882 restores the previous chip instead of leaving this test
  // unable to load; the assertions then compare the actual old/new UI.
  const replacementPath = '../viewport-ui/hud/VisibilityChips.js';
  const previousPath = './LevelDisplayIndicator.js';
  const StatusChip: ComponentType = await import(replacementPath)
    .then((module) => module.VisibilityChips)
    .catch(async () => (await import(previousPath)).LevelDisplayIndicator);
  act(() => useViewerStore.setState({ levelDisplayMode: 'exploded', explodedGap: 2 }));
  // `VisibilityChips` portals into `ViewportHud`'s top-left region
  // (#5504); mount the HUD host alongside it, or `HudItem` renders nothing.
  const exploded = render(<><ViewportHud /><StatusChip /></>);
  assert.ok(exploded.textContent?.includes('Exploded · 2 m gap'));

  registerLocale('visibilitychips-de', { 'visibilityChips.soloCount': 'Solo · {count} Geschoss' });
  act(() => useViewerStore.setState({ levelDisplayMode: 'solo', activeStorey: { modelId: 'm1', expressId: 1 } }));
  act(() => setLocale('visibilitychips-de'));
  const solo = render(<><ViewportHud /><StatusChip /></>);
  assert.ok(solo.textContent?.includes('Solo · 1 Geschoss'));
});

// ---- EntityContextMenu -----------------------------------------------------
// The context menu only mounts its `DuplicateRow` once `contextMenu.isOpen`
// is true AND a live mutation view makes `canEdit` true — not worth wiring
// a full mutation fixture just to read two labels back.

it('EntityContextMenu: the duplicate-row catalogue values resolve (#4918)', () => {
  assert.equal(resolve('entityContextMenu.duplicateDefaultTitle'), 'Duplicate one bbox-width along +X (default)');
  assert.equal(resolve('entityContextMenu.duplicateLabel'), 'Duplicate');
});

// ---- TextAnnotationEditor -----------------------------------------------------

it('TextAnnotationEditor: renders the placeholder and hint in English and translates them (#4918)', () => {
  const container = render(
    <TextAnnotationEditor
      annotation={{ id: 'a1', text: '', fontSize: 12 } as never}
      screenX={0}
      screenY={0}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
  const textarea = container.querySelector('textarea')!;
  assert.equal(textarea.getAttribute('placeholder'), 'Type annotation text...');
  assert.ok(container.textContent?.includes('Enter to confirm · Shift+Enter for newline · Esc to cancel'));

  registerLocale('textannotationeditor-de', { 'textAnnotationEditor.placeholder': 'Anmerkungstext eingeben...' });
  act(() => setLocale('textannotationeditor-de'));
  assert.equal(textarea.getAttribute('placeholder'), 'Anmerkungstext eingeben...');
});

// ---- presence/PeerPresenceLayer -------------------------------------------
// `PeerPresenceLayer.test.tsx` covers the component itself on the shared
// scene-overlay kernel's stub-driven projector (#5511); this is just the
// lightweight catalogue-resolution guard every trivial file in this sweep
// gets, so a locale regression is caught even without the fuller test.

it('PeerPresenceLayer: the cursor-pill catalogue values resolve (#4918)', () => {
  assert.equal(resolve('peerPresenceLayer.cursorsAriaLabel'), 'Collaborator cursors');
  assert.equal(resolve('peerPresenceLayer.guestName'), 'Guest');
  assert.equal(resolve('peerPresenceLayer.nameWithTool', { name: 'Anna', tool: 'measuring' }), 'Anna — measuring');
});

// ---- BottomStrip ------------------------------------------------------------
// The grip only mounts alongside a real docked panel body (`ClashPanel`,
// `BCFPanel`, …, each with its own heavy dependency graph) — not worth
// mounting one just to read its own drag-grip tooltip back.

it('BottomStrip: the drag-grip catalogue value resolves (#4918)', () => {
  assert.equal(resolve('bottomStrip.gripTitle'), 'Drag to float · drag onto another screen to pop out');
});

// ---- SaveMarkupToModelButton -----------------------------------------------

it('SaveMarkupToModelMenuItem: renders its label in English and translates it (#4918)', () => {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent><SaveMarkupToModelMenuItem /></DropdownMenuContent>
    </DropdownMenu>,
  );
  const item = document.querySelector('[role="menuitem"]')!;
  assert.equal(item.textContent, 'Save Markup to Model');

  registerLocale('savemarkuptomodelbutton-de', { 'saveMarkupToModelButton.menuItemLabel': 'Markup ins Modell speichern' });
  act(() => setLocale('savemarkuptomodelbutton-de'));
  assert.equal(item.textContent, 'Markup ins Modell speichern');
});

// ---- ExportChangesButton ----------------------------------------------------

function makeChangedModel(): FederatedModel {
  return {
    id: 'model-1',
    name: 'model-1.ifc',
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 3,
    sourceFile: new File([new Uint8Array([1, 2, 3])], 'model-1.ifc'),
    idOffset: 0,
    maxExpressId: 0,
  } as FederatedModel;
}

function makeChangedView(): MutablePropertyView {
  const view = new MutablePropertyView(null, 'model-1');
  view.setOnDemandExtractor((entityId) =>
    entityId === 7
      ? [{
          name: 'Pset_Base',
          globalId: 'g',
          properties: [{ name: 'Status', type: PropertyValueType.Label, value: 'Original' }],
        }]
      : [],
  );
  view.setProperty(7, 'Pset_Base', 'Status', 'Edited', PropertyValueType.Label);
  return view;
}

it('ExportChangesButton: renders the button label and single-change tooltip in English, and translates the label (#4918)', () => {
  act(() => {
    useViewerStore.setState({
      models: new Map([['model-1', makeChangedModel()]]),
      mutationViews: new Map([['model-1', makeChangedView()]]),
    });
  });
  const container = render(<ExportChangesButton />);
  assert.ok(container.textContent?.includes('Export modified IFC…'));
  assert.equal(resolve('exportChangesButton.tooltipSingle', { count: 1 }), 'Export IFC with 1 change applied');
  assert.equal(resolve('exportChangesButton.tooltipSingle', { count: 2 }), 'Export IFC with 2 changes applied');
  assert.equal(
    resolve('exportChangesButton.tooltipMulti', { models: 2, count: 3 }),
    'Export changes in 2 models (3 changes)',
  );

  registerLocale('exportchangesbutton-de', { 'exportChangesButton.buttonLabel': 'Änderungen exportieren' });
  act(() => setLocale('exportchangesbutton-de'));
  assert.ok(container.textContent?.includes('Änderungen exportieren'));
});
