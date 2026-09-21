/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Production-observing coverage for the ModelMetadataPanel statistics row.
 * The fixture has seven physical elements, but #3 has no representation.
 * #8 is an `IFCSPACE` — schema-legal, non-physical, and meshed — guarding
 * the schema filter (`collectPhysicalEntityIds`) independently of the shape
 * filter: a row can pass the shape test and still not belong in the count.
 */

import '@/test/setup-dom.js';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { federationRegistry } from '@ifc-lite/renderer';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types.js';
import type { LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics.js';
import { ModelMetadataPanel } from './ModelMetadataPanel.js';
import { registerLocale, setLocale } from '@/i18n';
import { useViewerStore } from '@/store';

const TYPES = new Map<number, string>([
  [1, 'IFCWALL'],
  [2, 'IFCBUILDINGELEMENTPROXY'],
  [3, 'IFCBUILDINGELEMENTPROXY'],
  [4, 'IFCSLAB'],
  [5, 'IFCDOOR'],
  [6, 'IFCWINDOW'],
  [7, 'IFCCOLUMN'],
  [8, 'IFCSPACE'],
]);
const BY_TYPE = new Map<string, number[]>();
for (const [id, type] of TYPES) BY_TYPE.set(type, [...(BY_TYPE.get(type) ?? []), id]);

function dataStore(): IfcDataStore {
  return {
    spatialHierarchy: { byStorey: new Map([[100, [...TYPES.keys()]]]) },
    entityIndex: { byType: BY_TYPE },
    entities: {
      getName: () => undefined,
      getGlobalId: () => undefined,
      getDescription: () => undefined,
    },
    relationships: undefined,
  } as unknown as IfcDataStore;
}

function model(overrides: Partial<FederatedModel> = {}): FederatedModel {
  return {
    id: 'stats-model',
    name: 'stats.ifc',
    ifcDataStore: dataStore(),
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 0,
    idOffset: federationRegistry.getOffset('stats-model') ?? 0,
    maxExpressId: 100,
    ...overrides,
  } as FederatedModel;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(subject: FederatedModel): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ModelMetadataPanel model={subject} />));
  mounted.push({ root, container });
  return container;
}

function statistic(container: HTMLElement, label: string): string | undefined {
  const row = [...container.querySelectorAll('div')].find((element) =>
    [...element.children].some((child) => child.textContent === label),
  );
  return row?.lastElementChild?.textContent ?? undefined;
}

function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

beforeEach(() => {
  setLocale('en');
  unmountAll();
  federationRegistry.clear();
  federationRegistry.registerModel('other-model', 100);
  federationRegistry.registerModel('stats-model', 100);
});

after(() => {
  setLocale('en');
  unmountAll();
  federationRegistry.clear();
});

describe('ModelMetadataPanel — Elements with Geometry', () => {
  it('formats metadata numbers with the active locale', () => {
    registerLocale('de-DE', {});
    setLocale('de-DE');
    const store = dataStore() as IfcDataStore & { entityCount: number; parseTime: number };
    store.entityCount = 1234;
    store.parseTime = 1234.5;
    const container = render(model({ ifcDataStore: store, fileSize: 1_264_128, maxExpressId: 1234 }));
    assert.equal(statistic(container, 'Total Entities'), '1.234');
    assert.equal(statistic(container, 'Max Express ID'), '1.234');
    assert.equal(statistic(container, 'File Size'), '1,21 MB');
    assert.equal(statistic(container, 'Parse Time'), '1.235 ms');
  });

  it('counts shaped physical elements using canonical federated ID resolution', () => {
    const offset = federationRegistry.getOffset('stats-model') ?? 0;
    const geometryResult = {
      meshes: [1, 2, 4, 5, 6].map((expressId) => ({ expressId: expressId + offset })),
      instancedGeometryHashes: new Map([[7 + offset, 0n]]),
    } as never;
    const container = render(model({ geometryResult, idOffset: offset, loadState: 'complete' }));
    assert.equal(statistic(container, 'Elements with Geometry'), '6');
  });

  it('excludes a meshed IFCSPACE — the schema filter, not just the shape filter, keeps it out', () => {
    // #8 passes the shape test (it has a mesh) but must still be excluded:
    // the schema filter (`collectPhysicalEntityIds`) is what keeps a
    // non-physical, shape-bearing row out of "Elements with Geometry", and a
    // fixture where every meshed id is also physical cannot exercise it.
    const offset = federationRegistry.getOffset('stats-model') ?? 0;
    const geometryResult = {
      meshes: [1, 2, 4, 5, 6, 8].map((expressId) => ({ expressId: expressId + offset })),
      instancedGeometryHashes: new Map([[7 + offset, 0n]]),
    } as never;
    const container = render(model({ geometryResult, idOffset: offset, loadState: 'complete' }));
    assert.equal(
      statistic(container, 'Elements with Geometry'),
      '6',
      'the meshed IFCSPACE must not raise the count above the six shaped physical elements',
    );
  });

  it('treats completed null geometry as known-empty', () => {
    const container = render(model({ geometryResult: null, loadState: 'complete' }));
    assert.equal(statistic(container, 'Elements with Geometry'), '0');
  });

  it('keeps the shape filter provisional while geometry is streaming', () => {
    const container = render(model({ geometryResult: null, loadState: 'streaming-geometry' }));
    assert.equal(statistic(container, 'Elements with Geometry'), '7');
  });

  it('opens preserved-only LandXML surface records, even when they have no overlay or mesh (#5042)', () => {
    const landXmlDocument: LandXmlTinDocument = {
      format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
      capabilities: { renderableTin: false, preservedOnlySurfaces: 1, unknownExtensions: 0 },
      units: null,
      surfaces: [{
        sourceId: 'volume-surface', ordinal: 1, sourcePath: 'LandXML/Surfaces/Surface[1]',
        properties: { name: 'Volume check' }, definitionProperties: { surfType: 'VOLUME' },
        name: 'Volume check', kind: 'volume', renderState: 'preserved_only',
        points: [], sourceDataPoints: [], faces: [], faceSourceIds: [], faceVisibility: [], hiddenFaceCount: 0,
        boundaries: [], breaklines: [], contours: [],
      }],
      extensions: [], warnings: [], alignments: [], profiles: [], crossSections: [], crossSectionSurfaces: [], roadways: [], capabilityDiagnostics: [], preservedOnlyExtensions: [], rendering: { meshProvenance: [], surfaceCounts: [{
        surfaceSourceId: 'volume-surface', sourcePoints: 0, sourceFaces: 0, hiddenFaces: 0,
        renderedFaces: 0, droppedDegenerateFaces: 0, droppedPrecisionFaces: 0, droppedReframeFaces: 0,
      }] },
    };
    const container = render(model({
      id: 'landxml-source', name: 'volume.xml', sourceSchema: 'LandXML-1.2', landXmlDocument,
      geometryResult: null, loadState: 'complete',
    }));
    const surface = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Volume check'));
    assert.ok(surface, 'the source-surface list includes non-rendered records, not only line overlays');
    act(() => surface.click());
    assert.deepEqual(useViewerStore.getState().selectedLandXmlSource, { modelId: 'landxml-source', sourceId: 'volume-surface' });
  });
});
