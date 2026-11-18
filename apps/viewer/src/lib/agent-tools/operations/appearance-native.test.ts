/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { Raycaster } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, SAMPLE_MODEL, GROUND_STOREY } from '@/test/authoring-sample-fixture';
import { fixtureModel } from '@/test/store-fixture';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { appearanceAssets, modelAppearanceAssets } from '@/lib/appearance/model-assets';
import { PdfAppearanceSource } from '@/lib/appearance/pdf/source-document';
import { registerPdfDocument, removePdfDocument } from '@/lib/appearance/pdf/documents';
import { controlledPdf } from '@/lib/appearance/pdf/fixtures';
import { rasterNativePdfSource } from '@/lib/appearance/appearance-native-pdf';
import type { PdfWorkerClient } from '@/lib/appearance/pdf/worker-client';
import type { PdfRasterRecipe } from '@/lib/appearance/pdf/types';
import { appendNativeScanPair, changeNativeScanPartition } from '@/lib/appearance/appearance-native-scan';
import { sourceLandmark } from '@/lib/appearance/scan/landmarks';
import { changeNativeFaceMask, faceMaskRequests } from '@/lib/appearance/face-masks';
import type { AppearancePlan } from '@/lib/appearance/planner-types';
import { createMainViewerToolHost } from '../main-viewer-host';
import { dispatchMainViewerTool, type AgentToolResult } from '../main-viewer-dispatch';
import { viewerOperation } from './registry';
import type { ToolHost } from '../types';
const png = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),
  (c) => c.charCodeAt(0),
);
let host: ToolHost;
const call = (id: string, input: unknown = {}, write = false) =>
  dispatchMainViewerTool(
    host,
    write ? 'viewer_operation_execute' : 'viewer_operation_inspect',
    { ...(viewerOperation(id).needs === 'model' ? { model_id: SAMPLE_MODEL } : {}), operation_id: id, input },
    { canEdit: () => true },
  );
function value<T>(result: AgentToolResult): T {
  assert.equal(result.isError, false, result.text);
  return JSON.parse((result.structured as { result: { native_json: string } }).result.native_json) as T;
}
describe('native Appearance controls and ownership (#10525 follow-up)', () => {
  beforeEach(async () => {
    await seedAuthoringSample();
    useViewerStore.setState({
      appearanceSources: [],
      appearanceReferences: new Map(),
      referenceUndo: [],
      referenceRedo: [],
      referenceRevision: 0,
      modelPlacement: emptyPlacementState(),
      collabRoomId: null,
    });
    modelAppearanceAssets.unregisterAuthored('capture-source', 'fixture');
    appearanceAssets.clear();
    host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  });
  it('calibrates actual encoded image coordinates with no IFC loaded and refuses a stale source snapshot', async () => {
    const calibrationImage = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAADklEQVR4nGP4jwQYkDkANvEX6SAXxcIAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const asset = await appearanceAssets.add(calibrationImage, {
      owner: { kind: 'source', id: 'calibration-fixture' },
      mimeType: 'image/png',
    });
    useViewerStore
      .getState()
      .addAppearanceSource({ id: asset.id, assetId: asset.id, name: 'Calibration.png', width: 3, height: 2 });
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, activeModelId: null });
    const read = value<{ expected_source: string }>(await call('appearance.source.inspect', { source_id: asset.id }));
    const input = {
      source_id: asset.id,
      expected_source: read.expected_source,
      fractions: [
        [0, 0],
        [1, 1],
      ],
      distance_metres: 2,
    };
    const calibrated = value<{ calibration: { sourcePoints: number[][]; distanceMetres: number } }>(
      await call('appearance.source.calibrate', input, true),
    );
    assert.deepEqual(calibrated.calibration, {
      sourcePoints: [
        [0, 0],
        [3, 2],
      ],
      distanceMetres: 2,
    });
    const current = useViewerStore.getState().appearanceSources[0];
    assert.equal((await call('appearance.source.calibrate', { ...input, distance_metres: 5 }, true)).isError, true);
    assert.equal(useViewerStore.getState().appearanceSources[0], current);
    assert.equal(
      (
        await call(
          'appearance.source.calibrate',
          {
            ...input,
            expected_source: JSON.stringify(current),
            fractions: [
              [0.5, 0.5],
              [0.5, 0.5],
            ],
          },
          true,
        )
      ).isError,
      true,
    );
  });
  it('releases an admitted native PDF raster when publication is stale or cancelled', async () => {
    // Deterministic one-pixel native worker boundary fixture: this tests ownership
    // and publication fencing, not the renderer returned by the fixture.
    const recipe: PdfRasterRecipe = {
      page: {
        pageNumber: 1,
        viewBox: [0, 0, 72, 72],
        userUnit: 1,
        intrinsicRotation: 0,
        widthPoints: 72,
        heightPoints: 72,
        pdfToPage: [1, 0, 0, -1, 0, 72],
      },
      rotation: 0,
      cropPoints: [0, 0, 72, 72],
      requestedDpi: 1,
      effectiveDpi: 1,
      pixelWidth: 1,
      pixelHeight: 1,
      paperSizeMetres: [0.0254, 0.0254],
      pixelToPdf: [72, 0, 0, -72, 0, 72],
    };
    const worker: PdfWorkerClient = {
      async run(_bytes, job) {
        if (job.kind === 'inspect') return { kind: 'inspect', pageCount: 1, page: recipe.page };
        if (job.kind === 'raster') return { kind: 'raster', png, recipe };
        throw new Error('Unexpected vector request');
      },
      cancel() {},
      dispose() {},
    };
    const document = await PdfAppearanceSource.open(new File([controlledPdf()], 'fixture.pdf'), appearanceAssets, {
      worker,
    });
    const key = registerPdfDocument(document),
      digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', png))]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('');
    try {
      await assert.rejects(
        rasterNativePdfSource(
          key,
          { pageNumber: 1, dpi: 1 },
          { signal: new AbortController().signal, isCurrent: () => false },
        ),
        /changed/,
      );
      assert.equal(appearanceAssets.get(digest), undefined);
      assert.equal(useViewerStore.getState().appearanceSources.length, 0);
      const abort = new AbortController();
      await assert.rejects(
        rasterNativePdfSource(
          key,
          { pageNumber: 1, dpi: 1 },
          {
            signal: abort.signal,
            isCurrent: () => {
              abort.abort();
              return true;
            },
          },
        ),
        { name: 'AbortError' },
      );
      assert.equal(appearanceAssets.get(digest), undefined);
      assert.equal(useViewerStore.getState().appearanceSources.length, 0);
    } finally {
      removePdfDocument(key);
    }
  });
  it('uses immutable native captured regions and refuses in-place source geometry changes before IFC creation', async () => {
    const asset = await appearanceAssets.add(png, {
      owner: { kind: 'source', id: 'capture-fixture' },
      mimeType: 'image/png',
    });
    modelAppearanceAssets.registerAuthored('capture-source', 'fixture', [asset.id]);
    const uri = modelAppearanceAssets.getAuthoredUri('capture-source', asset.id);
    const mesh: MeshData = {
      expressId: 10,
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, -2, 0, 0, 0, 0, 0, -2, -2, 0, 0]),
      normals: new Float32Array(18),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 0.25, 1, 1, 0, 1]),
      color: [1, 1, 1, 1],
      textureRef: { textureId: 1, url: uri, repeatS: false, repeatT: false },
    };
    const s = useViewerStore.getState(),
      target = s.models.get(SAMPLE_MODEL)!,
      source = {
        ...fixtureModel('capture-source'),
        loadedAt: 1,
        geometryResult: { ...target.geometryResult!, meshes: [mesh], totalTriangles: 2, totalVertices: 6 },
      };
    useViewerStore.setState({ models: new Map(s.models).set(source.id, source) });
    const container_id = target.ifcDataStore!.entities.getExpressIdByGlobalId(GROUND_STOREY);
    const prepared = value<{ token: string; triangles: number; positions: number }>(
      await call('appearance.capture.prepare', {
        source_model_id: source.id,
        mesh_ordinal: 0,
        triangles: [1, 0],
        container_id,
        Name: 'Reviewed surface',
      }),
    );
    assert.equal(prepared.triangles, 2);
    assert.equal(prepared.positions, 6);
    const before = useViewerStore.getState().mutationVersion;
    mesh.positions[0] = 9;
    const refused = await call('appearance.capture.create', { token: prepared.token }, true);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /changed|registration/i);
    assert.equal(useViewerStore.getState().mutationVersion, before);
  });
  it('shares fingerprint-bound native face edits and whole-surface semantics', () => {
    const conversions: NonNullable<AppearancePlan['conversions']> = [
      {
        productId: 7,
        representationId: 8,
        sourceGeometryItemId: 9,
        geometryItemId: 10,
        sourceIndices: [0, 1, 2, 3, 4, 5],
        surfaceFingerprint: 'native-surface',
      },
    ];
    const masks = changeNativeFaceMask(new Map(), conversions, 7, [1, 1]);
    assert.deepEqual(faceMaskRequests(masks, [7]), [
      { productId: 7, surfaceFingerprint: 'native-surface', triangles: [1] },
    ]);
    assert.equal(faceMaskRequests(changeNativeFaceMask(masks, conversions, 7, [0, 1]), [7]), undefined);
    assert.equal(faceMaskRequests(masks, [8]), undefined);
  });
  it('keeps real raycast source observations independent and refuses duplicate scan correspondences', () => {
    const mesh: MeshData = {
      expressId: 17,
      positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 8, 0]),
      indices: new Uint32Array([0, 1, 2]),
      normals: new Float32Array(9),
      color: [1, 1, 1, 1],
      origin: [1000000, 2000000, 30],
    };
    const hit = new Raycaster().raycast({ origin: { x: 1, y: 4, z: 10 }, direction: { x: 0, y: 0, z: -1 } }, [
      { ...mesh, origin: [0, 0, 0] },
    ]);
    assert.ok(hit);
    const point = sourceLandmark(mesh, hit, 3);
    assert.deepEqual(point.point, [1000001, 2000004, 30]);
    const pending = { point, partition: 'fit' as const },
      target = { point: [10, 20, 30] as [number, number, number], feature: 'native-ifc-triangle' };
    const pairs = appendNativeScanPair([], pending, target);
    const edge = sourceLandmark(mesh, { triangleIndex: 0, barycentricCoord: { w: -Number.EPSILON, u: 0.9, v: 0.1 } }, 3);
    assert.deepEqual(edge.barycentric, [0, 0.9, 0.1]);
    const fit = Array.from({ length: 256 }, (_, index) => ({
      ...pairs[0], correspondence: { ...pairs[0].correspondence, id: `fit-${index}` },
    }));
    const check = { ...pairs[0], partition: 'check' as const };
    assert.throws(() => changeNativeScanPartition([...fit, check], check.correspondence.id, 'fit'), /pairLimit/);

    assert.throws(
      () => appendNativeScanPair(pairs, pending, { ...target, feature: 'another-triangle' }),
      /duplicateLandmark/,
    );
    assert.throws(
      () => sourceLandmark(mesh, { triangleIndex: 0, barycentricCoord: { w: 2, u: 0, v: 0 } }, 3),
      /barycentric/,
    );
  });
  it('refuses forged Compare/scan tokens through the actual operation gateway', async () => {
    const initial = useViewerStore.getState().mutationVersion;
    assert.equal((await call('appearance.compare', { candidate_id: 'not-owned', original: true }, true)).isError, true);
    assert.equal((await call('appearance.scan.calculate', { token: 'not-owned', version: 0 }, true)).isError, true);
    assert.equal(useViewerStore.getState().mutationVersion, initial);
  });
});
