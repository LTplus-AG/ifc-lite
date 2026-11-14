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

  it('PDF resets Tz before a plain label that follows a stretched one', () => {
    const doc = new jsPDF({ unit: 'mm', format: [100, 100] });
    drawDxfUnderlaysPdf(doc, wrap(stretched, { ...stretched, text: 'Plain', widthScale: undefined }), mapPoint, 10);
    const tz = [...doc.output().matchAll(/([\d.]+) Tz/g)].map(m => Number(m[1]));
    assert.deepEqual(tz, [250, 100]);
  });

  describe('measured fit span (fitWidth)', () => {
    // Estimate says 2.5×, but the real font is narrower/wider than 0.6 em.
    const fit: Text = { ...stretched, fitWidth: 3 };

    it('canvas stretches by fitWidth / measured width, not the estimate', () => {
      const calls: string[] = [];
      const ctx = {
        save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
        setLineDash() {}, translate() {}, rotate() {}, scale(x: number, y: number) { calls.push(`scale ${x} ${y}`); },
        measureText: () => ({ width: 15 }), fillText() {}, textBaseline: 'alphabetic',
      } as unknown as CanvasRenderingContext2D;
      // 3 m at 10 px/m = 30 px over a measured 15 px line → 2 (the 0.6 em estimate would give 2.5).
      drawDxfUnderlaysScreenSpace(ctx, wrap({ ...fit, fitWidth: 3 }), mapPoint, w => w, h => h * 10);
      assert.deepEqual(calls, [`scale ${30 / 15} 1`]);
      calls.length = 0;
      drawDxfUnderlaysScreenSpace(ctx, wrap({ ...fit, fitWidth: 3.6 }), mapPoint, w => w, h => h * 10);
      assert.deepEqual(calls, [`scale ${36 / 15} 1`]);
    });

    it('canvas scales aligned (uniform) text in both axes to the measured span', () => {
      const calls: string[] = [];
      const ctx = {
        save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
        setLineDash() {}, translate() {}, rotate() {}, scale(x: number, y: number) { calls.push(`scale ${x} ${y}`); },
        measureText: () => ({ width: 15 }), fillText() {}, textBaseline: 'alphabetic',
      } as unknown as CanvasRenderingContext2D;
      drawDxfUnderlaysScreenSpace(ctx, wrap({ ...fit, widthScale: undefined, fitUniform: true }), mapPoint, w => w, h => h * 10);
      assert.deepEqual(calls, ['scale 2 2']);
    });

    it('PDF reaches an aligned span by font size, not Tz', () => {
      const doc = new jsPDF({ unit: 'mm', format: [100, 100] });
      doc.getTextWidth = () => 24;
      const sizes: number[] = [];
      const setFontSize = doc.setFontSize.bind(doc);
      doc.setFontSize = (size: number) => { sizes.push(size); return setFontSize(size); };
      drawDxfUnderlaysPdf(doc, wrap({ ...fit, widthScale: undefined, fitUniform: true }), mapPoint, 10);
      assert.doesNotMatch(doc.output(), / Tz/);
      // 0.5 m × 10 mm/m = 5 mm text, scaled by 30 / 24 = 1.25.
      assert.ok(Math.abs(sizes.at(-1)! - 5 * 1.25 * 72 / 25.4) < 1e-9);
    });

    it('canvas falls back to widthScale for a zero or non-finite measured width', () => {
      for (const width of [0, NaN, Infinity]) {
        const calls: string[] = [];
        const ctx = {
          save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
          setLineDash() {}, translate() {}, rotate() {}, scale(x: number) { calls.push(`scale ${x}`); },
          measureText: () => ({ width }), fillText() {}, textBaseline: 'alphabetic',
        } as unknown as CanvasRenderingContext2D;
        drawDxfUnderlaysScreenSpace(ctx, wrap(fit), mapPoint, w => w, h => h * 10);
        assert.deepEqual(calls, ['scale 2.5']);
      }
    });

    it('PDF stretches by fitWidth / getTextWidth', () => {
      const doc = new jsPDF({ unit: 'mm', format: [100, 100] });
      // fitWidth 3 m × 10 mm/m = 30 mm over a measured 24 mm → 125% (the estimate would give 250%).
      doc.getTextWidth = () => 24;
      drawDxfUnderlaysPdf(doc, wrap(fit), mapPoint, 10);
      assert.match(doc.output(), /125\.? Tz/);
      assert.doesNotMatch(doc.output(), /250\.? Tz/);
    });

    it('PDF falls back to widthScale when the measured width is unusable', () => {
      const doc = new jsPDF({ unit: 'mm', format: [100, 100] });
      doc.getTextWidth = () => 0;
      drawDxfUnderlaysPdf(doc, wrap(fit), mapPoint, 10);
      assert.match(doc.output(), /250\.? Tz/);
    });

    it('SVG uses textLength instead of the scale transform', () => {
      const svg = buildDxfUnderlaySvg(wrap(fit), mapPoint, mm => mm, 10, s => s);
      assert.match(svg, /textLength="30\.0000" lengthAdjust="spacingAndGlyphs"/);
      assert.doesNotMatch(svg, /scale\(/);
    });

    it('carries fitWidth into the package facade', () => {
      const [{ underlay }] = mappedDxfUnderlayOptions(wrap(fit));
      assert.equal(underlay.layers[0].texts[0].fitWidth, 3);
    });
  });

  it('carries widthScale and line spacing into the package facade', () => {
    const [{ underlay }] = mappedDxfUnderlayOptions(wrap({ ...stretched, text: 'a\nb', lineSpacingFactor: 2 }));
    const [a, b] = underlay.layers[0].texts;
    assert.equal(a.widthScale, 2.5);
    // 0.5 high at factor 2 → 0.5 * 5/3 * 2 line pitch.
    assert.ok(Math.abs(Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y) - 0.5 * 5 / 3 * 2) < 1e-9);
  });
});
