/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Focus a clash, switch the theme: the pair in 3D keeps matching the panel's
 * side dots (#5490).
 *
 * The pair is painted through the colour-override channel, whose overlay
 * batches bake the colour in at focus time. A theme switch updated the app's
 * `CLASH_COLOR_A` / `_B` and the panel's dots, and nothing rebuilt the
 * batches, so the 3D pair kept the previous theme's colours.
 *
 * Everything on the path is real: the panel (its row click is the focus), the
 * `useClash` it mounts, `useColorOverlaySync` handing the paint to a real
 * `Renderer`'s `Scene`, the theme effect in `useRenderUpdates`, and the dots'
 * colour as the app's compiled stylesheet resolves it. Only the GPU objects are
 * stand-ins: a scene with no meshes builds no batches, so they are never used.
 * What the scene was HANDED is recorded per rebuild, as a copy, because that is
 * what its batches are built from.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, useRef } from 'react';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { IfcParser } from '@ifc-lite/parser';
import { Renderer, type VisualEnhancementOptions } from '@ifc-lite/renderer';
import { summarizeClashes, type Clash, type ClashResult } from '@ifc-lite/clash';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { cleanup, click, render } from '@/test/render.js';
import { ClashPanel } from './ClashPanel.js';
import { useColorOverlaySync } from './useColorOverlaySync.js';
import { useRenderUpdates } from './useRenderUpdates.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../..');

// ─── Fixture: one model, two walls ──────────────────────────────────────────

const STEP = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_NAME('','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
  "#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);",
  "#2=IFCWALL('0bbbbbbbbbbbbbbbbbbbbb',$,'Wall B',$,$,$,$,$,.STANDARD.);",
  'ENDSEC;', 'END-ISO-10303-21;', '',
].join('\n');

function box(expressId: number, dx: number): MeshData {
  const positions = new Float32Array([
    dx, 0, 0, dx + 1, 0, 0, dx + 1, 1, 0, dx, 1, 0, dx, 0, 1, dx + 1, 0, 1, dx + 1, 1, 1, dx, 1, 1,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  return { expressId, ifcType: 'IfcWall', positions, normals: new Float32Array(positions.length), indices, color: [0.5, 0.5, 0.5, 1] };
}

const CLASH: Clash = {
  id: 'clash-1',
  a: { key: 'A:1', ref: 1, model: 'A', tag: 'IfcWall', name: 'Wall A' },
  b: { key: 'A:2', ref: 2, model: 'A', tag: 'IfcWall', name: 'Wall B' },
  rule: 'all-clashes',
  status: 'hard',
  distance: -0.5,
  point: [0.75, 0.5, 0.5],
  bounds: { min: [0.5, 0, 0], max: [1, 1, 1] },
  severity: 'major',
};

const RESULT: ClashResult = {
  clashes: [CLASH],
  summary: summarizeClashes([CLASH]),
  rulesRun: [{ id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' }],
  settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
};

async function seed(): Promise<void> {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(STEP).buffer as ArrayBuffer, { disableWorkerScan: true });
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 1 } };
  const geometryResult: GeometryResult = {
    meshes: [box(1, 0), box(2, 0.5)], totalTriangles: 24, totalVertices: 16,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false },
  };
  const model: FederatedModel = {
    id: 'A', name: 'A.ifc', ifcDataStore: store, geometryResult, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 0, fileSize: 0, idOffset: 0, maxExpressId: 2,
  };
  useViewerStore.setState({
    models: new Map([['A', model]]),
    clashResult: RESULT,
    clashGroups: null,
    clashError: null,
    clashSelectedId: null,
    clashHighlightColors: null,
    clashStatusFilter: new Set(['open', 'resolved', 'accepted']),
    clashHideTouching: false,
    lensAppliedColors: null,
    pendingColorUpdates: null,
  });
}

// ─── A real renderer whose GPU objects are never reached ────────────────────

type Rgba = [number, number, number, number];

function makeRenderer(): { renderer: Renderer; builds: Array<Map<number, number[]>> } {
  const renderer = new Renderer({
    width: 256, height: 256, getBoundingClientRect: () => ({ width: 256, height: 256 }),
  } as unknown as HTMLCanvasElement);
  const fields = renderer as unknown as Record<string, unknown>;
  fields['device'] = { isInitialized: () => true, getDevice: () => ({ limits: {} }) };
  fields['pipeline'] = { selectionColorUniform: { update() { /* not asserted */ } } };
  const scene = renderer.getScene() as unknown as { setColorOverrides(o: Map<number, Rgba>, d: unknown, p: unknown): void };
  const builds: Array<Map<number, number[]>> = [];
  const real = scene.setColorOverrides.bind(scene);
  scene.setColorOverrides = (o, d, p) => {
    builds.push(new Map([...o].map(([id, c]) => [id, [...c]])));
    real(o, d, p);
  };
  return { renderer, builds };
}

/** The viewport's colour and theme plumbing, without the canvas around it. */
function ViewportBridge({ renderer }: { renderer: Renderer }): null {
  const s = useViewerStore();
  const rendererRef = useRef<Renderer | null>(renderer);
  const clearColorRef = useRef<Rgba>([0, 0, 0, 1]);
  const visualEnhancementRef = useRef({} as VisualEnhancementOptions);
  const hiddenEntitiesRef = useRef(s.hiddenEntities);
  const isolatedEntitiesRef = useRef(s.isolatedEntities);
  const selectedEntityIdRef = useRef(s.selectedEntityId);
  const selectedModelIndexRef = useRef<number | undefined>(undefined);
  const selectedEntityIdsRef = useRef(s.selectedEntityIds);
  const sectionPlaneRef = useRef(s.sectionPlane);
  const sectionRangeRef = useRef<{ min: number; max: number } | null>(null);
  const activeToolRef = useRef(s.activeTool);
  useColorOverlaySync({
    rendererRef, isInitialized: true,
    pendingColorUpdates: s.pendingColorUpdates, clearPendingColorUpdates: s.clearPendingColorUpdates,
  });
  useRenderUpdates({
    rendererRef, isInitialized: true, theme: s.theme, clearColorRef, visualEnhancementRef,
    hiddenEntities: s.hiddenEntities, isolatedEntities: s.isolatedEntities, ghostExceptEntities: s.ghostExceptEntities,
    selectedEntityId: s.selectedEntityId, selectedEntityIds: s.selectedEntityIds, selectedModelIndex: undefined,
    activeTool: s.activeTool, sectionPlane: s.sectionPlane, sectionRange: null,
    hiddenEntitiesRef, isolatedEntitiesRef, selectedEntityIdRef, selectedModelIndexRef, selectedEntityIdsRef,
    sectionPlaneRef, sectionRangeRef, activeToolRef,
    drawing2D: null, show3DOverlay: false, showHiddenLines: false,
  });
  return null;
}

// ─── The app's stylesheet, compiled for the panel, as selection-accent does ──

let sheet: HTMLStyleElement | null = null;

before(async () => {
  const input = `@import "./index.css";\n@source "./components/viewer/ClashPanel.tsx";\n`;
  const result = await postcss([tailwindcss()]).process(input, { from: join(SRC, 'clash-theme.probe.css'), to: undefined });
  // happy-dom drops every rule inside `@layer`; unwrap them in cascade order.
  const root = postcss.parse(result.css);
  root.walkAtRules('layer', (layer) => {
    if (layer.nodes) layer.replaceWith(layer.nodes);
    else layer.remove();
  });
  sheet = document.createElement('style');
  sheet.textContent = root.toString();
  document.head.appendChild(sheet);
});

after(() => {
  sheet?.remove();
});

afterEach(() => {
  cleanup();
  useViewerStore.getState().setTheme('light');
  useViewerStore.setState({ clashResult: null, clashGroups: null, models: new Map(), pendingColorUpdates: null });
});

function hex(rgba: readonly number[]): string {
  return `#${rgba.slice(0, 3).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
}

function dotColour(container: HTMLElement, side: 'a' | 'b'): string {
  const dot = container.querySelector<HTMLElement>(`[data-clash-side="${side}"]`);
  assert.ok(dot, `side ${side.toUpperCase()} dot is on screen`);
  return getComputedStyle(dot).backgroundColor.trim().toLowerCase();
}

describe('a focused clash pair repaints on a theme switch (#5490)', () => {
  it('after light -> dark, the 3D pair is painted in the colours of the panel dots', async () => {
    await seed();
    useViewerStore.getState().setTheme('light');
    const { renderer, builds } = makeRenderer();
    const container = render(
      <>
        <ViewportBridge renderer={renderer} />
        <ClashPanel />
      </>,
    );

    // Expand the row (shows the side dots), then click it (focuses the pair).
    const expand = container.querySelector<HTMLElement>('button[title="Show both objects"]');
    assert.ok(expand, 'the clash row is listed');
    click(expand);
    const focusRow = expand.nextElementSibling as HTMLElement | null;
    assert.ok(focusRow, 'the row focus button sits next to the expand toggle');
    await act(async () => { focusRow.click(); });

    const painted = builds.at(-1);
    assert.ok(painted && painted.has(1) && painted.has(2), 'focusing the clash painted both elements in 3D');
    assert.equal(hex(painted.get(1)!), dotColour(container, 'a'), 'light: element A matches the side A dot');
    assert.equal(hex(painted.get(2)!), dotColour(container, 'b'), 'light: element B matches the side B dot');
    const lightA = dotColour(container, 'a');

    await act(async () => { useViewerStore.getState().setTheme('dark'); });

    assert.notEqual(dotColour(container, 'a'), lightA, 'setup sanity: the dots did change with the theme');
    const repainted = builds.at(-1)!;
    assert.equal(hex(repainted.get(1)!), dotColour(container, 'a'), 'dark: element A is repainted to the side A dot');
    assert.equal(hex(repainted.get(2)!), dotColour(container, 'b'), 'dark: element B is repainted to the side B dot');
  });
});
