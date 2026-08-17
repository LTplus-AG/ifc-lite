/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The to-scale 3D-view PDF dialog's page arithmetic (#2042).
 *
 * DEFECT CLASS — a readout that is present but wrong. "The dialog shows a page
 * size" is worth nothing to an engineer: what matters is that the number is the
 * one the sheet will actually be, that halving the scale factor doubles the
 * drawn area, and that a scale which cannot be printed blocks the export
 * instead of producing a clamped (silently mis-scaled) PDF. So every assertion
 * here is a NUMBER derived by hand from the fixture, not a presence check.
 *
 * The fixture is chosen so a transposed axis, a dropped margin or a missing
 * re-orthogonalisation all move the numbers: the model is 4 m x 3 m x 2 m (three
 * different extents), seen down -Z with world +Y up, so the drawing must be
 * 4 m wide by 3 m tall and never 3 x 4 or 4 x 2.
 *
 *   1:100 -> 1 m prints as 10 mm -> drawing 40 x 30 mm -> page 60 x 50 mm
 *   1:50  -> 1 m prints as 20 mm -> drawing 80 x 60 mm -> page 100 x 80 mm
 *
 * (The 10 mm margin per side is fixed, so the PAGE does not double while the
 * DRAWING does. Both are asserted.)
 *
 * Every sheet also carries a scale bar and the printed ratio in a band below
 * the drawing, which adds a fixed 17 mm of height and no width — so the quoted
 * pages above become 60 x 67 mm and 100 x 97 mm. The readout has to say so
 * BEFORE the export runs, because it is the number that decides whether the
 * page can be printed at all.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store/index.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { setGlobalCanvasRef, setGlobalRendererRef, clearGlobalRefs } from '@/hooks/useBCF.js';
import { render, click, cleanup } from '@/test/render.js';
import { PdfViewExportDialog, type ViewPdfExporter } from './PdfViewExportDialog.js';
import type { ViewPdfExportInput } from '@/lib/export/view-pdf/generate-view-pdf.js';

// ── Fixture geometry: an axis-aligned box, 4 m x 3 m x 2 m at the origin ────
const BOX_MAX = { x: 4, y: 3, z: 2 };

/**
 * A box big enough that an INTEGER custom scale can still overflow the PDF page
 * limit. The 4 m fixture cannot: the largest enlargement a whole-number scale
 * allows is 1:1 (1000 mm per metre), so 4 m tops out at 4020 mm, inside the
 * 5080 mm limit. 60 m at 1:10 is 6020 mm, which is outside it.
 */
const BIG_BOX_MAX = { x: 60, y: 40, z: 2 };

function boxMesh(max: { x: number; y: number; z: number } = BOX_MAX): MeshData {
  const positions: number[] = [];
  for (const x of [0, max.x]) {
    for (const y of [0, max.y]) {
      for (const z of [0, max.z]) positions.push(x, y, z);
    }
  }
  // Two triangles are enough for the bounds; the drawing itself is not asserted.
  return {
    expressId: 501,
    ifcType: 'IfcWall',
    modelIndex: 0,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2, 5, 6, 7]),
    color: [1, 1, 1, 1],
  };
}

function boxGeometry(max: { x: number; y: number; z: number } = BOX_MAX): GeometryResult {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { ...max } };
  return {
    meshes: [boxMesh(max)],
    totalTriangles: 2,
    totalVertices: 8,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: bounds,
      shiftedBounds: bounds,
      hasLargeCoordinates: false,
    },
  };
}

/**
 * A renderer stand-in exposing exactly the four getters the export reads.
 * Orthographic, 500 CSS px tall, `orthoSize` 5 m: the displayed scale is then
 * 10000 mm of world over (500 * 25.4 / 96) mm of screen = 1:75.59.
 */
function fakeRenderer(max: { x: number; y: number; z: number } = BOX_MAX): Renderer {
  const camera = {
    getPosition: () => ({ x: 2, y: 1.5, z: 10 }),
    getTarget: () => ({ x: 2, y: 1.5, z: 1 }),
    getUp: () => ({ x: 0, y: 1, z: 0 }),
    getProjectionMode: () => 'orthographic' as const,
    getOrthoSize: () => 5,
    getDistance: () => 9,
    getFOV: () => Math.PI / 4,
    getSceneBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { ...max } }),
  };
  return {
    getCamera: () => camera,
    getScene: () => ({ getAllInstancedMeshData: () => [] }),
  } as unknown as Renderer;
}

function seedViewer(max: { x: number; y: number; z: number } = BOX_MAX): void {
  const model = fixtureModel('m1', { idOffset: 0 });
  useViewerStore.setState({
    ...fixtureModels({ ...model, geometryResult: boxGeometry(max) }),
    hiddenEntities: new Set<number>(),
    isolatedEntities: null,
    classFilter: null,
    selectedStoreys: new Set<number>(),
    projectionMode: 'orthographic',
  });

  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientHeight', { value: 500, configurable: true });
  setGlobalCanvasRef({ current: canvas });
  setGlobalRendererRef({ current: fakeRenderer(max) });
}

// ── Dialog driving ──────────────────────────────────────────────────────────

function openDialog(exportViewPdf?: ViewPdfExporter): void {
  const container = render(
    <PdfViewExportDialog trigger={<button type="button">Open</button>} exportViewPdf={exportViewPdf} />,
  );
  const trigger = container.querySelector('button');
  assert.ok(trigger, 'the dialog trigger must render');
  click(trigger);
  assert.ok(document.body.querySelector('[role="dialog"]'), 'clicking the trigger must open the dialog');
}

/** Radix Select opens on ArrowDown and portals its listbox to `document.body`. */
function chooseFrom(selectId: string, optionLabel: string): void {
  const selectTrigger = document.body.querySelector(selectId);
  assert.ok(selectTrigger, `the ${selectId} select must render`);
  act(() => {
    selectTrigger.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
  });
  const option = [...document.body.querySelectorAll('[role="option"]')].find(
    (o) => o.textContent === optionLabel,
  );
  assert.ok(option, `the "${optionLabel}" scale option must be offered`);
  act(() => {
    option.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
}

function chooseScale(optionLabel: string): void {
  chooseFrom('#pdf-view-scale', optionLabel);
}

function chooseAppearance(optionLabel: string): void {
  chooseFrom('#pdf-view-render-mode', optionLabel);
}

function hiddenEdgesSwitch(): HTMLButtonElement {
  const el = document.body.querySelector('#pdf-view-hidden-edges');
  assert.ok(el, 'the hidden edges switch must render');
  return el as HTMLButtonElement;
}

function scaleStampSwitch(): HTMLButtonElement {
  const el = document.body.querySelector('#pdf-view-scale-stamp');
  assert.ok(el, 'the scale stamp switch must render');
  return el as HTMLButtonElement;
}

function stampNote(): string {
  const el = document.body.querySelector('[data-testid="pdf-view-scale-stamp-note"]');
  assert.ok(el, 'the scale stamp note must render');
  return el.textContent ?? '';
}

function readout(): string {
  const el = document.body.querySelector('[data-testid="pdf-view-page-readout"]');
  assert.ok(el, 'the page readout must render');
  return el.textContent ?? '';
}

function exportButton(): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Export',
  );
  assert.ok(button, 'the Export button must render');
  return button as HTMLButtonElement;
}

function typeCustomScale(value: string): void {
  chooseScale('Custom');
  const input = document.body.querySelector('#pdf-view-custom-scale');
  assert.ok(input, 'the custom scale input must render');
  const field = input as HTMLInputElement;
  act(() => {
    // React tracks the last value it wrote; bypass that tracker so a
    // programmatic set is seen as a real change (React's own recipe).
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

describe('PdfViewExportDialog page arithmetic (#2042)', () => {
  beforeEach(() => {
    seedViewer();
  });

  afterEach(() => {
    cleanup();
    clearGlobalRefs();
    document.body.innerHTML = '';
  });

  it('reports the exact page the sheet will be at 1:100', () => {
    openDialog();
    chooseScale('1:100');
    // 4 m x 3 m at 10 mm/m, plus 10 mm of margin on each side, plus the
    // 17 mm scale band. 60 x 67 is portrait, so the containing sheet is too.
    assert.match(readout(), /Estimated page: 60 x 67 mm \(fits A4 Portrait\)/);
  });

  it('doubles the drawn area when the scale factor halves to 1:50', () => {
    openDialog();
    chooseScale('1:100');
    assert.match(readout(), /Estimated page: 60 x 67 mm/);
    chooseScale('1:50');
    // Drawing 80 x 60: the DRAWING doubled (40x30 -> 80x60) while the fixed
    // 10 mm margin and the 17 mm scale band did not, so a test asserting a
    // doubled PAGE would be wrong.
    assert.match(readout(), /Estimated page: 100 x 97 mm/);
  });

  it('offers the viewport\'s own scale as the default, stated as a number', () => {
    openDialog();
    // orthoSize 5 m over 500 CSS px: 10000 mm of world per (500*25.4/96) mm of
    // screen = 75.5905..., which the shared label formatter rounds to 75.59.
    const options = [...document.body.querySelectorAll('#pdf-view-scale')];
    assert.equal(options.length, 1);
    assert.match(options[0].textContent ?? '', /As displayed \(about 1:75\.59\)/);
  });

  it('disables Export for a custom scale of 0', () => {
    openDialog();
    chooseScale('1:100');
    assert.equal(exportButton().disabled, false, 'a valid preset must leave Export enabled');
    typeCustomScale('0');
    assert.equal(exportButton().disabled, true, '1:0 is not a scale and must not be exportable');
  });

  it('blocks a scale whose page exceeds the PDF page limit', () => {
    // The 4 m fixture cannot reach the limit at a whole-number scale, so this
    // uses the 60 m box: at 1:10 it draws 6000 mm, past the 5080 mm limit.
    seedViewer(BIG_BOX_MAX);
    openDialog();
    chooseScale('1:10');
    assert.match(readout(), /Estimated page: 6020 x 4037 mm/);
    assert.match(
      document.body.textContent ?? '',
      /A PDF page cannot exceed 5080 mm on a side/,
      'the oversize warning must name the limit',
    );
    assert.equal(exportButton().disabled, true, 'an unprintable page must block Export');
  });

  it('refuses to export rather than inventing a scale when the viewport cannot report one', () => {
    // A zero-height canvas makes the displayed scale underivable. The label
    // says so; the danger is the EXPORT quietly substituting a default. On a
    // sheet whose whole purpose is measurement, handing back a 1:100 drawing
    // the user never chose is the exact failure this feature exists to
    // prevent, and it would look completely normal on screen.
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'clientHeight', { value: 0, configurable: true });
    setGlobalCanvasRef({ current: canvas });

    openDialog();
    assert.match(
      document.body.textContent ?? '',
      /As displayed \(not available\)/,
      'the unavailable state must be stated, not hidden',
    );
    assert.equal(
      exportButton().disabled,
      true,
      'Export must be blocked, not silently fall back to 1:100',
    );

    // A real scale is still reachable: the user picks a preset.
    chooseScale('1:100');
    assert.equal(exportButton().disabled, false, 'choosing a preset must re-enable Export');
  });

  it('quotes the page WITH the scale band, and shrinks it when the band is off', () => {
    // The band is part of the sheet, so a readout that ignored it would under-
    // report the page by 17 mm - and under-report it in exactly the direction
    // that lets an unprintable page look printable.
    openDialog();
    chooseScale('1:100');
    assert.equal(scaleStampSwitch().getAttribute('aria-checked'), 'true', 'the stamp is on by default');
    assert.match(readout(), /Estimated page: 60 x 67 mm/);
    click(scaleStampSwitch());
    assert.equal(scaleStampSwitch().getAttribute('aria-checked'), 'false');
    assert.match(readout(), /Estimated page: 60 x 50 mm/);
  });

  it('quotes the ratio the sheet will print, hedged when two decimals had to round it', () => {
    // The dialog's DEFAULT is "as displayed", which here is 1:75.5905... Two
    // decimals cannot hold that, so the sheet prints "about 1:75.59" and the
    // note has to quote the SHEET rather than a tidier number of its own -
    // otherwise the dialog promises a ratio the paper does not carry.
    openDialog();
    assert.match(stampNote(), /the text "Scale about 1:75\.59"/);
    chooseScale('1:100');
    assert.match(stampNote(), /the text "Scale 1:100"/);
    assert.equal(
      /about/.test(stampNote()),
      false,
      'a preset ratio is exact, and a hedge on every sheet would stop meaning anything',
    );
  });

  it('rounds a custom scale to a whole number, and draws at the rounded scale', () => {
    // Drafting scales are whole numbers. A fractional entry must not silently
    // draw a sheet at 1:33.7 while the user reads "1:34" anywhere else, so the
    // rounding happens BEFORE the factor reaches the layout: 33.7 and 34 must
    // produce the identical page, and 33.4 must produce a DIFFERENT one (which
    // is what fails if the rounding is dropped and the raw value is used).
    openDialog();
    typeCustomScale('34');
    const atWholeScale = readout();
    typeCustomScale('33.7');
    assert.equal(readout(), atWholeScale, '1:33.7 must draw exactly the 1:34 sheet');
    typeCustomScale('33.4');
    assert.notEqual(readout(), atWholeScale, '1:33.4 must round to 33, not to 34');
  });
});

/**
 * What the dialog actually SENDS.
 *
 * DEFECT CLASS — a control the user moves that the exported sheet ignores. It
 * has already happened once in this file's component: the hidden-edges switch
 * shipped frozen at its mount-time default because a `useCallback` dependency
 * array missed it, so the switch animated, the option was honoured perfectly
 * one layer down, and every exported PDF came out byte-identical. Nothing below
 * the dialog can see that, and there is no exhaustive-deps lint here to catch
 * it, so the only test that can is one that drives the real controls and reads
 * back the input the exporter was handed.
 */
describe('PdfViewExportDialog export input (#2042)', () => {
  const EXPORT_RESULT = {
    page: { widthMm: 60, heightMm: 50 },
    filename: '3d-view-1-100.pdf',
    strokeCount: 12,
    shading: { widthPx: 237, heightPx: 178, dpi: 150 },
  };

  function recordingExporter(): { calls: ViewPdfExportInput[]; exporter: ViewPdfExporter } {
    const calls: ViewPdfExportInput[] = [];
    return {
      calls,
      exporter: async (input) => {
        calls.push(input);
        return EXPORT_RESULT;
      },
    };
  }

  /** Click Export and let the async handler settle. */
  async function runExport(): Promise<void> {
    const button = exportButton();
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  beforeEach(() => {
    seedViewer();
  });

  afterEach(() => {
    cleanup();
    clearGlobalRefs();
    document.body.innerHTML = '';
  });

  it('exports shaded surfaces unless the user asks otherwise', async () => {
    const { calls, exporter } = recordingExporter();
    openDialog(exporter);
    chooseScale('1:100');
    await runExport();

    assert.equal(calls.length, 1, 'Export must reach the exporter exactly once');
    // The whole point of the feature: the sheet looks like the viewport, which
    // is solid and coloured, unless the user opts out.
    assert.equal(calls[0].renderMode, 'shaded');
    assert.equal(calls[0].scaleFactor, 100);
  });

  it('sends the appearance the user picked, not the one the dialog mounted with', async () => {
    const { calls, exporter } = recordingExporter();
    openDialog(exporter);
    chooseScale('1:100');
    chooseAppearance('Line work only');
    await runExport();

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].renderMode,
      'lines',
      'a frozen callback would still report the mount-time "shaded" here',
    );
  });

  it('sends the hidden-edges choice too, and disables it while shading', async () => {
    const { calls, exporter } = recordingExporter();
    openDialog(exporter);
    chooseScale('1:100');

    // Shaded mode: the raster resolves occlusion, so the switch is dead by
    // design rather than merely ignored downstream.
    assert.equal(hiddenEdgesSwitch().disabled, true, 'the switch must be disabled while shading');

    chooseAppearance('Line work only');
    const toggle = hiddenEdgesSwitch();
    assert.equal(toggle.disabled, false, 'line work mode must re-enable the switch');
    assert.equal(toggle.getAttribute('aria-checked'), 'true', 'hidden edges default to on');
    click(toggle);
    assert.equal(hiddenEdgesSwitch().getAttribute('aria-checked'), 'false');

    await runExport();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].renderMode, 'lines');
    assert.equal(
      calls[0].includeHiddenLines,
      false,
      'turning the switch off must reach the exporter',
    );
  });

  it('sends the scale-stamp choice, and defaults it to on', async () => {
    // The same frozen-callback class as the hidden-edges switch: the control
    // animates, the exporter honours whatever it is given, and the sheet comes
    // out with a scale record the user just turned off (or without the one they
    // left on, which is the dangerous direction).
    const first = recordingExporter();
    openDialog(first.exporter);
    chooseScale('1:100');
    await runExport();
    assert.equal(first.calls.length, 1);
    assert.equal(
      first.calls[0].includeScaleStamp,
      true,
      'a sheet must state its own scale unless the user says otherwise',
    );

    cleanup();
    document.body.innerHTML = '';

    const second = recordingExporter();
    openDialog(second.exporter);
    chooseScale('1:100');
    click(scaleStampSwitch());
    await runExport();
    assert.equal(second.calls.length, 1);
    assert.equal(
      second.calls[0].includeScaleStamp,
      false,
      'a frozen callback would still report the mount-time "true" here',
    );
  });

  it('names the shading stages while it works, instead of a bare "Working"', async () => {
    // An unmapped stage id falls through to "Working", so this fails the moment
    // the shading stages are emitted without a label for them.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const exporter: ViewPdfExporter = async (input) => {
      input.onProgress?.('shading', 0);
      await gate;
      return EXPORT_RESULT;
    };

    openDialog(exporter);
    chooseScale('1:100');
    const button = exportButton();
    act(() => {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    assert.match(
      button.textContent ?? '',
      /Shading surfaces/,
      `the shading stage must be named, got "${button.textContent}"`,
    );

    await act(async () => {
      release();
      await gate;
    });
  });
});
