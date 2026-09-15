/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for #4802: a reviewed 2D section can be attached directly to a
 * BCF topic. The test mounts the real drawing canvas and BCF panel together,
 * paints an annotation, clicks the user-facing action, and observes the topic.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { GeometryResult } from '@ifc-lite/geometry';
import { createBCFProject, createBCFTopic, writeBCF } from '@ifc-lite/bcf';
import { GraphicOverrideEngine, type Drawing2D } from '@ifc-lite/drawing-2d';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF.js';
import { drawingWithReferenceBounds } from '@/lib/appearance/references/drawing.js';
import { Drawing2DCanvas } from './Drawing2DCanvas.js';
import { BCFPanel } from './BCFPanel.js';

installLayout();

const DRAWING: Drawing2D = {
  config: {
    plane: { axis: 'y', position: 4, flipped: false },
    projectionDepth: 10,
    includeHiddenLines: false,
    creaseAngle: 30,
    scale: 100,
  },
  lines: [],
  cutPolygons: [],
  projectionPolygons: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  stats: {
    cutLineCount: 0,
    projectionLineCount: 0,
    hiddenLineCount: 0,
    silhouetteLineCount: 0,
    polygonCount: 0,
    totalTriangles: 0,
    processingTimeMs: 0,
  },
};

const TEXT_ANNOTATION = {
  id: 'review-note',
  position: { x: 2, y: 3 },
  text: 'Check fire rating',
  fontSize: 14,
  color: '#000000',
  backgroundColor: '#ffffff',
  borderColor: '#ff0000',
};

function boundedGeometry(maxY: number, minY = 0): GeometryResult {
  const bounds = { min: { x: 0, y: minY, z: 0 }, max: { x: 10, y: maxY, z: 10 } };
  return geometryWithBounds(bounds);
}

function geometryWithBounds(bounds: GeometryResult['coordinateInfo']['originalBounds']): GeometryResult {
  return {
    meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds,
      shiftedBounds: bounds, hasLargeCoordinates: false },
  };
}

function TestSectionCanvas({ drawing = DRAWING, snapshotSourceDrawing }: {
  drawing?: Drawing2D;
  snapshotSourceDrawing?: Drawing2D;
} = {}): React.ReactElement {
  const textAnnotations = useViewerStore((state) => state.textAnnotations2D);
  const textAnnotationEditing = useViewerStore((state) => state.textAnnotation2DEditing);
  return (
    <Drawing2DCanvas
      drawing={drawing}
      snapshotSourceDrawing={snapshotSourceDrawing}
      transform={{ x: 100, y: 100, scale: 10 }}
      showHiddenLines={false}
      overrideEngine={new GraphicOverrideEngine()}
      overridesEnabled={false}
      entityColorMap={new Map()}
      useIfcMaterials={false}
      sectionAxis="down"
      textAnnotations={textAnnotations}
      textAnnotationEditing={textAnnotationEditing}
    />
  );
}

const renderer = {
  getCamera: () => ({
    getPosition: () => ({ x: 10, y: 5, z: 20 }),
    getTarget: () => ({ x: 1, y: 2, z: 3 }),
    getUp: () => ({ x: 0, y: 1, z: 0 }),
    getFOV: () => Math.PI / 4,
    getAspect: () => 16 / 9,
  }),
} as unknown as Renderer;

let topicGuid = '';
let paintedText: string[] = [];

beforeEach(() => {
  paintedText = [];
  const context = new Proxy({}, {
    get(_target, property) {
      if (property === 'measureText') return (text: string) => ({ width: text.length * 7 });
      if (property === 'fillText') return (text: string) => { paintedText.push(text); };
      if (property === 'canvas') return { width: 1280, height: 800 };
      return () => undefined;
    },
    set() { return true; },
  }) as unknown as CanvasRenderingContext2D;
  mock.method(HTMLCanvasElement.prototype, 'getContext', (kind: string) => kind === '2d' ? context : null);
  mock.method(HTMLCanvasElement.prototype, 'toDataURL', () =>
    `data:image/png;base64,${Buffer.from(paintedText.join('|')).toString('base64')}`);

  const project = createBCFProject({ name: 'Section review' });
  const topic = createBCFTopic({ title: 'Reviewed section', author: 'reviewer@example.invalid' });
  topicGuid = topic.guid;
  project.topics.set(topic.guid, topic);
  useViewerStore.setState({
    bcfProject: project,
    activeTopicId: topic.guid,
    models: new Map(),
    hiddenEntities: new Set(),
    isolatedEntities: null,
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    drawing2D: DRAWING,
    drawing2DStatus: 'ready',
    drawing2DPanelVisible: true,
    textAnnotations2D: [TEXT_ANNOTATION],
    textAnnotation2DEditing: null,
    sectionPlane: {
      ...useViewerStore.getState().sectionPlane,
      enabled: true,
      axis: 'down',
      position: 50,
      flipped: false,
      custom: undefined,
    },
  });
  setGlobalRendererRef({ current: renderer });
});

afterEach(() => {
  cleanup();
  clearGlobalRefs();
  mock.restoreAll();
});

test('Capture 2D attaches the painted annotated section to the active BCF topic (#4802)', async () => {
  const ui = render(
    <>
      <TestSectionCanvas />
      <BCFPanel onClose={() => {}} />
    </>,
  );

  const capture = ui.querySelector<HTMLButtonElement>('[aria-label="Capture current 2D section as viewpoint"]');
  assert.ok(capture, 'the active topic exposes the dedicated 2D capture action');
  assert.equal(capture.disabled, false, 'a visible generated section is capturable');
  await act(async () => {
    capture.click();
    await Promise.resolve();
  });

  const topic = useViewerStore.getState().bcfProject?.topics.get(topicGuid);
  assert.equal(topic?.viewpoints.length, 1);
  const viewpoint = topic?.viewpoints[0];
  assert.ok(viewpoint?.perspectiveCamera, 'the existing BCF camera semantics are preserved');
  assert.ok(viewpoint.snapshot, 'the viewpoint carries an image');
  const imagePayload = Buffer.from(viewpoint.snapshot.split(',')[1] ?? '', 'base64').toString();
  assert.match(imagePayload, /Check fire rating/, 'the captured canvas includes the reviewed annotation');
});

test('Capture 2D accepts reference-expanded bounds painted for the generated drawing (#4802)', () => {
  const corners = [{ x: -5, y: -4 }, { x: 15, y: -4 }, { x: 15, y: 14 }, { x: -5, y: 14 }] as const;
  const drawingWithReferences = drawingWithReferenceBounds(DRAWING, [corners]);
  assert.notEqual(drawingWithReferences, DRAWING, 'reference bounds are a derived display drawing');

  const ui = render(<><TestSectionCanvas drawing={drawingWithReferences} snapshotSourceDrawing={DRAWING} /><BCFPanel onClose={() => {}} /></>);
  const capture = ui.querySelector<HTMLButtonElement>('[aria-label="Capture current 2D section as viewpoint"]');
  assert.ok(capture);
  assert.equal(capture.disabled, false, 'derived reference bounds retain the generated drawing identity');
});

test('Capture 2D includes its cut when the 3D clipping toggle is off (#4802)', async () => {
  useViewerStore.setState({
    sectionPlane: { ...useViewerStore.getState().sectionPlane, enabled: false },
  });
  const ui = render(<><TestSectionCanvas /><BCFPanel onClose={() => {}} /></>);
  const capture = ui.querySelector<HTMLButtonElement>('[aria-label="Capture current 2D section as viewpoint"]');
  assert.ok(capture);
  await act(async () => {
    capture.click();
    await Promise.resolve();
  });
  const viewpoint = useViewerStore.getState().bcfProject?.topics.get(topicGuid)?.viewpoints[0];
  assert.equal(viewpoint?.clippingPlanes?.length, 1,
    'the reviewed drawing carries its own cut independently of the 3D clip toggle');
  assert.equal(viewpoint.clippingPlanes[0]?.location.z, DRAWING.config.plane.position);
});

test('Capture 2D preserves the generated cut with degenerate primary federated bounds (#4802)', async () => {
  const small = { ...fixtureModel('small'), geometryResult: boundedGeometry(0) };
  const tall = { ...fixtureModel('tall', { idOffset: 1_000_000 }), geometryResult: boundedGeometry(30) };
  const federatedDrawing = { ...DRAWING, config: { ...DRAWING.config,
    plane: { ...DRAWING.config.plane, position: 15 } } };
  useViewerStore.setState({
    ...fixtureModels(small, tall),
    drawing2D: federatedDrawing,
  });

  const ui = render(<><TestSectionCanvas drawing={federatedDrawing} /><BCFPanel onClose={() => {}} /></>);
  const capture = ui.querySelector<HTMLButtonElement>('[aria-label="Capture current 2D section as viewpoint"]');
  assert.ok(capture);
  await act(async () => {
    capture.click();
    await Promise.resolve();
  });

  const viewpoint = useViewerStore.getState().bcfProject?.topics.get(topicGuid)?.viewpoints[0];
  assert.equal(viewpoint?.clippingPlanes?.length, 1);
  assert.equal(viewpoint.clippingPlanes[0]?.location.z, 15,
    'the BCF cut preserves y=15 even though the first model has a zero-height range');
});

test('Capture 2D preserves an absolute cut outside the primary model bounds (#4802)', async () => {
  const primary = { ...fixtureModel('primary'), geometryResult: boundedGeometry(10) };
  const translated = { ...fixtureModel('translated', { idOffset: 1_000_000 }), geometryResult: boundedGeometry(130, 100) };
  const federatedDrawing = { ...DRAWING, config: { ...DRAWING.config,
    plane: { ...DRAWING.config.plane, position: 115 } } };
  useViewerStore.setState({
    ...fixtureModels(primary, translated),
    drawing2D: federatedDrawing,
  });

  const ui = render(<><TestSectionCanvas drawing={federatedDrawing} /><BCFPanel onClose={() => {}} /></>);
  const capture = ui.querySelector<HTMLButtonElement>('[aria-label="Capture current 2D section as viewpoint"]');
  assert.ok(capture);
  await act(async () => {
    capture.click();
    await Promise.resolve();
  });

  const viewpoint = useViewerStore.getState().bcfProject?.topics.get(topicGuid)?.viewpoints[0];
  assert.equal(viewpoint?.clippingPlanes?.length, 1);
  assert.equal(viewpoint.clippingPlanes[0]?.location.z, 115,
    'percentage conversion through primary bounds 0..10 reconstructs the absolute federated cut');
});

const NUMERIC_CAPTURE_CASES = [
  {
    name: 'overflowing selected-axis range',
    bounds: { min: { x: 0, y: -Number.MAX_VALUE, z: 0 }, max: { x: 10, y: Number.MAX_VALUE, z: 10 } },
    cut: 42,
  },
  {
    name: 'selected-axis cancellation',
    bounds: { min: { x: 0, y: -1e20, z: 0 }, max: { x: 10, y: 1e20, z: 10 } },
    cut: 42,
  },
  {
    name: 'selected-axis reconstruction overflow',
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 1e6, z: 10 } },
    cut: Number.MAX_VALUE,
  },
  {
    name: 'off-axis midpoint overflow',
    bounds: { min: { x: 1e308, y: 0, z: 0 }, max: { x: 1.1e308, y: 0, z: 10 } },
    cut: 42,
  },
] as const;

for (const scenario of NUMERIC_CAPTURE_CASES) {
  test(`Capture 2D serializes the exact finite cut with ${scenario.name} (#4802)`, async () => {
    const extreme = { ...fixtureModel('extreme'), geometryResult: geometryWithBounds(scenario.bounds) };
    const extremeDrawing = { ...DRAWING, config: { ...DRAWING.config,
      plane: { ...DRAWING.config.plane, position: scenario.cut } } };
    useViewerStore.setState({ ...fixtureModels(extreme), drawing2D: extremeDrawing });

    const ui = render(<><TestSectionCanvas drawing={extremeDrawing} /><BCFPanel onClose={() => {}} /></>);
    const capture = ui.querySelector<HTMLButtonElement>('[aria-label="Capture current 2D section as viewpoint"]');
    assert.ok(capture);
    await act(async () => { capture.click(); await Promise.resolve(); });

    const project = useViewerStore.getState().bcfProject;
    const plane = project?.topics.get(topicGuid)?.viewpoints[0]?.clippingPlanes?.[0];
    assert.ok(plane);
    assert.equal(plane.location.z, scenario.cut, 'the serialized BCF coordinate preserves the exact viewer Y cut');
    assert.ok(Object.values(plane.location).every(Number.isFinite), 'all clipping-plane coordinates stay finite');
    assert.ok((await writeBCF(project)).size > 0, 'the actual BCF writer accepts the captured clipping plane');
  });
}

test('unmounting the production canvas disables its active capture lease (#4802)', () => {
  function Harness(): React.ReactElement {
    const [visible, setVisible] = useState(true);
    return <>
      {visible ? <TestSectionCanvas /> : null}
      <button type="button" aria-label="Close section" onClick={() => setVisible(false)} />
      <BCFPanel onClose={() => {}} />
    </>;
  }

  const ui = render(<Harness />);
  const capture = ui.querySelector<HTMLButtonElement>('[aria-label="Capture current 2D section as viewpoint"]');
  const close = ui.querySelector<HTMLButtonElement>('[aria-label="Close section"]');
  assert.ok(capture);
  assert.ok(close);
  assert.equal(capture.disabled, false, 'the mounted production canvas is capturable');
  act(() => close.click());
  assert.equal(capture.disabled, true, 'teardown releases the canvas and drawing without waiting for another generation');
});

test('Capture 2D stays disabled for a custom plane that BCF cannot reproduce (#4802)', () => {
  useViewerStore.setState({
    sectionPlane: {
      ...useViewerStore.getState().sectionPlane,
      enabled: true,
      axis: 'down',
      position: 50,
      flipped: false,
      custom: {
        normal: [0, Math.SQRT1_2, Math.SQRT1_2],
        distance: 4,
        pickedAt: [0, 2, 2],
        tangent: [1, 0, 0],
        bitangent: [0, Math.SQRT1_2, -Math.SQRT1_2],
      },
    },
  });
  const ui = render(<><TestSectionCanvas /><BCFPanel onClose={() => {}} /></>);
  const capture = ui.querySelector<HTMLButtonElement>('[aria-label="Capture current 2D section as viewpoint"]');
  assert.ok(capture);
  assert.equal(capture.disabled, true, 'an oblique image must not be paired with an unrelated cardinal clip');
});

test('Capture 2D waits for the active text editor to commit and repaint (#4802)', async () => {
  useViewerStore.setState({ textAnnotation2DEditing: TEXT_ANNOTATION.id });
  const ui = render(<><TestSectionCanvas /><BCFPanel onClose={() => {}} /></>);
  const capture = ui.querySelector<HTMLButtonElement>('[aria-label="Capture current 2D section as viewpoint"]');
  assert.ok(capture);
  assert.equal(capture.disabled, true, 'the DOM-only editor content is not capturable yet');

  await act(async () => {
    useViewerStore.setState({
      textAnnotations2D: [{ ...TEXT_ANNOTATION, text: 'Committed fire rating' }],
      textAnnotation2DEditing: null,
    });
  });
  assert.equal(capture.disabled, false, 'capture enables only after the canvas repaint completes');
  await act(async () => {
    capture.click();
    await Promise.resolve();
  });

  const viewpoint = useViewerStore.getState().bcfProject?.topics.get(topicGuid)?.viewpoints[0];
  assert.ok(viewpoint?.snapshot);
  const imagePayload = Buffer.from(viewpoint.snapshot.split(',')[1] ?? '', 'base64').toString();
  assert.match(imagePayload, /Committed fire rating/);
});
