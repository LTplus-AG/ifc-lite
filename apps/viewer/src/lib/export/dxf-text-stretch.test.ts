/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import type { DxfUnderlayRenderData } from '@/hooks/useDxfUnderlay.js';
import { drawDxfUnderlaysScreenSpace } from '@/components/viewer/drawing-underlays.js';
import { buildDxfUnderlaySvg, drawDxfUnderlaysPdf, mappedDxfUnderlayOptions } from './drawing-vector-underlays.js';

/** Aligned/fit/width-factor text (`widthScale`) and MTEXT line spacing reach every renderer. */
const mapPoint = (x: number, y: number) => ({ x: 50 + x * 10, y: 50 - y * 10 });
type Text = DxfUnderlayRenderData['texts'][number];
const stretched: Text = { x: 2, y: 3, dirX: 1, dirY: 0, height: 0.5, text: 'Fit', color: '#000000',
  align: 'left', valign: 'baseline', widthScale: 2.5 };
const wrap = (...texts: Text[]): DxfUnderlayRenderData[] => [{ id: 'd', opacity: 1, lines: [], fills: [], texts }];

describe('stretched DXF text', () => {
  it('canvas scales horizontally after rotating', () => {
    const calls: string[] = [];
    const ctx = {
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
      setLineDash() {}, translate() {}, rotate() { calls.push('rotate'); },
      scale(x: number, y: number) { calls.push(`scale ${x} ${y}`); },
      fillText() { calls.push('fillText'); }, textBaseline: 'alphabetic',
    } as unknown as CanvasRenderingContext2D;
    drawDxfUnderlaysScreenSpace(ctx, wrap(stretched), mapPoint, w => w, h => h * 10);
    assert.deepEqual(calls, ['rotate', 'scale 2.5 1', 'fillText']);
  });

  it('SVG stretches about the anchor and omits the transform at scale 1', () => {
    const svg = buildDxfUnderlaySvg(wrap(stretched), mapPoint, mm => mm, 10, s => s);
    assert.match(svg, /rotate\(0\.00 70\.0000 20\.0000\) translate\(70\.0000 20\.0000\) scale\(2\.5000 1\) translate\(-70\.0000 -20\.0000\)"/);
    assert.doesNotMatch(buildDxfUnderlaySvg(wrap({ ...stretched, widthScale: 1 }), mapPoint, mm => mm, 10, s => s), /scale\(/);
  });

  it('PDF applies a horizontal scale (Tz) and justifies on the stretched width', () => {
    const doc = new jsPDF({ unit: 'mm', format: [100, 100] });
    drawDxfUnderlaysPdf(doc, wrap(stretched), mapPoint, 10);
    assert.match(doc.output(), /250\.? Tz/);
    const plain = new jsPDF({ unit: 'mm', format: [100, 100] });
    drawDxfUnderlaysPdf(plain, wrap({ ...stretched, widthScale: undefined }), mapPoint, 10);
    assert.doesNotMatch(plain.output(), / Tz/);
  });

  it('carries widthScale and line spacing into the package facade', () => {
    const [{ underlay }] = mappedDxfUnderlayOptions(wrap({ ...stretched, text: 'a\nb', lineSpacingFactor: 2 }));
    const [a, b] = underlay.layers[0].texts;
    assert.equal(a.widthScale, 2.5);
    // 0.5 high at factor 2 → 0.5 * 5/3 * 2 line pitch.
    assert.ok(Math.abs(Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y) - 0.5 * 5 / 3 * 2) < 1e-9);
  });
});
