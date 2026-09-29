/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Secondary text in the Compare, Properties and IDS panels clears WCAG AA
 * (#4792, #6205). Each site is measured on the rendered element, found by its
 * visible text, in the real panel mounted in the state that shows it:
 * `ComparePanel` with a selected change (count badges, "what changed" detail),
 * `PropertiesPanel` over a parsed store with the world-coordinates section
 * open, and `IDSPanel` with an audit issue expanded. Each panel paints its own
 * surface (`AnalysisPanel`'s `bg-background`, `PropertiesPanel`'s
 * `bg-white dark:bg-black`, the audit summary's `bg-card`); every one is
 * docked by `SidebarPanelHost`, which paints nothing, inside `ViewerLayout`'s
 * root, so the snapshot is wrapped in {@link VIEWER_SHELL_SURFACE} (matters
 * for `.colorful`, whose `bg-background`/`bg-card` are translucent glass).
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelDiff } from '@ifc-lite/diff';
import type { MeshData } from '@ifc-lite/geometry';
import type { IDSAuditReport, IDSDocument } from '@ifc-lite/ids';
import { resolve } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import type { CompareResult } from '@/store/slices/compareSlice';
import type { CompareRef } from '@/lib/compare/buildFingerprints';
import { ComparePanel } from '@/components/viewer/ComparePanel.js';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel.js';
import { IDSPanel } from '@/components/viewer/IDSPanel.js';
import { cleanup, click, render } from '@/test/render.js';
import { parseStep, seedModel } from '@/test/properties-panel-harness.js';
import { closeContrastBrowser, warmContrastBrowser } from './render-harness.js';
import {
  assertRenderedTextClears,
  assertForcedClassReddens,
  snapshotRenderedDom,
  THEMES,
  VIEWER_SHELL_SURFACE,
} from './rendered-text-contrast.js';
import { WCAG_AA_NORMAL_TEXT } from './wcag.js';

const initialState = useViewerStore.getState();
const COORDINATES_DISCLOSURE_KEY = 'ifc-lite:properties:section:coordinates';

afterEach(() => {
  cleanup();
  localStorage.removeItem(COORDINATES_DISCLOSURE_KEY);
  useViewerStore.setState(initialState, true);
});
before(warmContrastBrowser, { timeout: 300_000 });
after(closeContrastBrowser);

/** The one element on screen whose own text is `text`. */
function elementWithText(text: string): Element {
  const hit = [...document.body.querySelectorAll('*')].find((el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim() === text));
  assert.ok(hit, `"${text}" must be on screen`);
  return hit;
}

// ---------------------------------------------------------------------------
// ComparePanel: count badges + "what changed" detail for the selected change
// ---------------------------------------------------------------------------

/** A box mesh spanning `min`..`max` (renderer frame) for federation id `globalId`. */
function boxMesh(globalId: number, min: [number, number, number], max: [number, number, number]): MeshData {
  return { expressId: globalId, positions: new Float32Array([...min, ...max]) } as unknown as MeshData;
}

function compareModel(id: string, meshes: MeshData[]): FederatedModel {
  return {
    id, name: `${id}.ifc`, ifcDataStore: null, geometryResult: { meshes }, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: id === 'A' ? 1 : 2, fileSize: 0, idOffset: 0, maxExpressId: 10,
  } as unknown as FederatedModel;
}

function ref(modelId: string, localId: number): CompareRef {
  return { modelId, localId, globalId: localId };
}

function modified(key: string, localId: number, baseType: string, headType: string, changeKinds: string[]) {
  return {
    key, state: 'modified', changeKinds,
    base: { key, ifcType: baseType, ref: ref('A', localId) },
    head: { key, ifcType: headType, ref: ref('B', localId) },
  };
}

/**
 * Two revisions; the selected wall (`guid-1`) changed its IFC class (one data
 * delta, so the "(1)" count and the before -> after arrow render) and its box
 * went from 1x1x1 at the origin to 2x1x1 five metres along x, unless
 * `sameBox`, where only the shape hash differs. A type object also changed, so
 * the "Changed" badge carries its "+1 type object" hint.
 */
function mountCompare({ sameBox }: { sameBox: boolean }): void {
  const entries = [
    modified('guid-1', 1, 'IfcWall', sameBox ? 'IfcWall' : 'IfcWallStandardCase', sameBox ? ['geometry'] : ['data', 'geometry']),
    modified('guid-2', 2, 'IfcWallType', 'IfcWallType', ['data']),
  ];
  const diff = {
    scope: 'both', excludedTypes: [], entries,
    byKey: new Map(entries.map((e) => [e.key, e])),
    counts: { added: 0, modified: 2, deleted: 0, unchanged: 0 },
  } as unknown as ModelDiff<CompareRef>;
  useViewerStore.setState({
    models: new Map([
      ['A', compareModel('A', [boxMesh(1, [0, 0, 0], [1, 1, 1])])],
      ['B', compareModel('B', [sameBox ? boxMesh(1, [0, 0, 0], [1, 1, 1]) : boxMesh(1, [5, 0, 0], [7, 1, 1])])],
    ]),
    compareBaseModelId: 'A',
    compareHeadModelId: 'B',
    compareResult: {
      baseModelId: 'A', headModelId: 'B', baseName: 'A.ifc', headName: 'B.ifc',
      scope: 'both', geometryUnavailable: false, diff,
    } as unknown as CompareResult,
    compareSelectedKey: 'guid-1',
  });
  render(<ComparePanel onClose={() => {}} />);
}

const COUNT_BADGE_HINT = '+1 type object';
const DATA_COUNT = '(1)';
const ARROW = '→';
const MOVED_LINE = resolve('comparePanel.changeDetail.movedLine', { distance: '5.50', dx: '5.50', dy: '0', dz: '0' });
const SIZE_LINE = resolve('comparePanel.changeDetail.sizeLine', { dx: '+1.00', dy: '0', dz: '0' });
const SHAPE_HASH_NOTICE = resolve('comparePanel.changeDetail.unchangedShapeHash');

describe('ComparePanel secondary text contrast (#4792, #6205)', () => {
  for (const theme of THEMES) {
    it(`CountBadge hint, data count, moved/reshaped lines and before/after arrow clear AA in ${theme}`, async () => {
      mountCompare({ sameBox: false });
      await assertRenderedTextClears(theme, snapshotRenderedDom(VIEWER_SHELL_SURFACE),
        [COUNT_BADGE_HINT, DATA_COUNT, MOVED_LINE, SIZE_LINE, ARROW], WCAG_AA_NORMAL_TEXT);
    });

    it(`"shape hash differs" notice clears AA in ${theme}`, async () => {
      mountCompare({ sameBox: true });
      await assertRenderedTextClears(theme, snapshotRenderedDom(VIEWER_SHELL_SURFACE), [SHAPE_HASH_NOTICE], WCAG_AA_NORMAL_TEXT);
    });

    it(`non-vacuousness: text-muted-foreground/60 shrink-0 on ChangeDetailView before/after arrow reddens in ${theme}`, async (t) => {
      mountCompare({ sameBox: false });
      const ratios = await assertForcedClassReddens(theme, ARROW, 'text-muted-foreground/60 shrink-0', WCAG_AA_NORMAL_TEXT, VIEWER_SHELL_SURFACE);
      t.diagnostic(ratios.map((r) => `${r.toFixed(2)}:1`).join(', '));
    });
  }
});

// ---------------------------------------------------------------------------
// PropertiesPanel: world-coordinates section, opened, "Size" row
// ---------------------------------------------------------------------------

const MODEL_ID = 'm1';
const ID_OFFSET = 1_000_000;
const WALL_STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#42=IFCWALL('0Wall00000000000000042',$,'Wall A',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

const SIZE_LABEL = resolve('properties.panel.sizeLabel');
const SIZE_VALUE = resolve('properties.panel.sizeDisplay', { x: '2.00', y: '3.00', z: '4.00' });

/** The wall selected, with a 2x3x4 mesh, and the world-coordinates section opened by a click. */
async function mountPropertiesSize(): Promise<void> {
  const store = await parseStep(WALL_STEP);
  seedModel(MODEL_ID, ID_OFFSET, store, 42);
  const model = useViewerStore.getState().models.get(MODEL_ID);
  assert.ok(model);
  useViewerStore.setState({
    models: new Map([[MODEL_ID, { ...model, geometryResult: { meshes: [boxMesh(42 + ID_OFFSET, [0, 0, 0], [2, 3, 4])] } } as unknown as FederatedModel]]),
  });
  render(<PropertiesPanel />);
  click(elementWithText(resolve('properties.panel.worldCoordinates')));
}

describe('PropertiesPanel "Size" row contrast (#4792, #6205)', () => {
  before(() => localStorage.removeItem(COORDINATES_DISCLOSURE_KEY));

  for (const theme of THEMES) {
    it(`"Size" label and value clear AA in ${theme}`, async () => {
      await mountPropertiesSize();
      await assertRenderedTextClears(theme, snapshotRenderedDom(VIEWER_SHELL_SURFACE), [SIZE_LABEL, SIZE_VALUE], WCAG_AA_NORMAL_TEXT);
    });

    it(`non-vacuousness: text-[9px] font-medium text-muted-foreground/50 on PropertiesPanel "Size" label reddens in ${theme}`, async (t) => {
      await mountPropertiesSize();
      const ratios = await assertForcedClassReddens(theme, SIZE_LABEL, 'text-[9px] font-medium text-muted-foreground/50', WCAG_AA_NORMAL_TEXT, VIEWER_SHELL_SURFACE);
      t.diagnostic(ratios.map((r) => `${r.toFixed(2)}:1`).join(', '));
    });
  }
});

// ---------------------------------------------------------------------------
// IDSPanel: audit summary expanded, one issue's detail opened
// ---------------------------------------------------------------------------

const IDS_DOCUMENT: IDSDocument = {
  info: { title: 'Translated pset IDS', version: '1.0' },
  specifications: [{
    id: 'spec-a', name: 'Space requirements', ifcVersions: ['IFC4'],
    applicability: { facets: [] }, requirements: [],
  }],
};
const ISSUE_MESSAGE = 'Pset_SpaceCommon.IsExternal is typed IFCBOOLEAN in the standard, not IFCTEXT';
const DETAIL_KEY = 'expectedDataType';
const AUDIT_REPORT: IDSAuditReport = {
  status: 'error',
  parsedDocument: IDS_DOCUMENT,
  issues: [{
    severity: 'error',
    code: 'W_IFC_DATATYPE_MISMATCH',
    message: ISSUE_MESSAGE,
    path: 'specifications[0].requirements[1].dataType',
    facetType: 'property',
    detail: { [DETAIL_KEY]: 'IFCBOOLEAN' },
  }],
};

/** A parsed document whose audit raised one issue; the user opens the list, then the issue. */
function mountIdsAuditDetail(): void {
  useViewerStore.setState({
    idsDocument: IDS_DOCUMENT,
    idsValidationReport: null,
    idsAuditReport: AUDIT_REPORT,
    idsAuditing: false,
    idsError: null,
    idsLoading: false,
    idsProgress: null,
  });
  render(<IDSPanel />);
  click(elementWithText(resolve('idsPanel.audit.details')));
  click(elementWithText(ISSUE_MESSAGE));
}

describe('IDSAuditSummary issue detail contrast (#4792, #6205)', () => {
  for (const theme of THEMES) {
    it(`"path", "facet" and detail key labels clear AA in ${theme}`, async () => {
      mountIdsAuditDetail();
      await assertRenderedTextClears(theme, snapshotRenderedDom(VIEWER_SHELL_SURFACE),
        [resolve('idsPanel.audit.path'), resolve('idsPanel.audit.facet'), DETAIL_KEY], WCAG_AA_NORMAL_TEXT);
    });
  }
});
