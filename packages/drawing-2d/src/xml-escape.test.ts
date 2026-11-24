/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #11467: one control character in an IFC string made the exported SVG
 * not well-formed XML. Every case writes the hostile string through an
 * exported writer and asks `xmllint --noout` (the XML parser itself, not a
 * regex of ours) whether the document parses.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { exportToSVG } from './svg-exporter.js';
import { renderTitleBlock } from './sheet/title-block-renderer.js';
import { escapeXml, entityIdAttr, svgNum } from './xml-escape.js';
import { DEFAULT_SECTION_CONFIG, type Drawing2D } from './types.js';
import type { TitleBlockConfig } from './sheet/title-block-types.js';
import type { DxfUnderlay } from './dxf/types.js';

const HOSTILE = ['\u0001', '\u000B', '\u0000', '￾', 'x\uD800y', 'a\uDC00'];

function wellFormed(xml: string): { ok: boolean; err: string } {
  const r = spawnSync('xmllint', ['--noout', '-'], { input: xml, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { ok: r.status === 0, err: r.stderr };
}
const doc = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">${body}</svg>`;

const drawing = (ifcType: string, entityId = 7): Drawing2D => ({
  config: { ...DEFAULT_SECTION_CONFIG, plane: { axis: 'z', position: 0, flipped: false }, scale: 100 },
  lines: [{ line: { start: { x: 0, y: 0 }, end: { x: 5, y: 5 } }, category: 'cut', visibility: 'visible', entityId, ifcType, modelIndex: 0, depth: 0 }],
  cutPolygons: [{ polygon: { outer: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }], holes: [] }, ifcType, entityId, modelIndex: 0, isCut: true }],
  projectionPolygons: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  stats: { cutLineCount: 1, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0, polygonCount: 1, totalTriangles: 0, processingTimeMs: 0 },
});

const block = (value: string): TitleBlockConfig => ({
  layout: 'standard', position: 'bottom-right', widthMm: 180, heightMm: 60, borderWeight: 0.5, gridWeight: 0.25,
  fields: [{ id: 'f', label: value, value, editable: true, autoPopulate: false, fontSize: 3, fontWeight: 'normal', row: 0, col: 0 }],
  logo: null, showRevisionHistory: false, maxRevisionEntries: 0,
});

describe('SVG writers emit well-formed XML for hostile strings (#11467)', () => {
  for (const bad of HOSTILE) {
    const tag = JSON.stringify(bad);
    it(`escapeXml output parses: ${tag}`, () => {
      const r = wellFormed(doc(`<text a="${escapeXml(bad)}">${escapeXml(bad)}</text>`));
      expect(r.ok, r.err).toBe(true);
    });
    it(`SVGExporter ifcType ${tag}`, () => {
      const r = wellFormed(exportToSVG(drawing(`Ifc${bad}Wall`), {}));
      expect(r.ok, r.err).toBe(true);
    });
    it(`SVGExporter title block text and underlay names ${tag}`, () => {
      const u: DxfUnderlay = { name: `s${bad}`, unitScale: 1, skipped: {}, warnings: [], bounds: { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } },
        layers: [{ name: `L${bad}`, color: '#000000', visible: true, fills: [], paths: [], texts: [] } as never] };
      const r = wellFormed(exportToSVG(drawing('IfcWall'), { showTitleBlock: true, title: `T${bad}`, projectName: `P${bad}`, underlays: [{ underlay: u }] } as never));
      expect(r.ok, r.err).toBe(true);
    });
    it(`renderTitleBlock field ${tag}`, () => {
      const { svgElements } = renderTitleBlock(block(`v${bad}`), { x: 0, y: 0, width: 420, height: 297 }, []);
      const r = wellFormed(doc(svgElements));
      expect(r.ok, r.err).toBe(true);
    });
  }

  it('replaces lone surrogates (xmllint cannot see them through UTF-8, so assert directly)', () => {
    expect(escapeXml('x\uD800y\uDC00')).toBe('x\uFFFDy\uFFFD');
    expect(escapeXml('\uD83D\uDE00')).toBe('\uD83D\uDE00');
  });
  it('keeps TAB, LF, CR and astral characters', () => {
    expect(escapeXml('a\tb\nc\rd\u{1F600}')).toBe('a\tb\nc\rd\u{1F600}');
  });
  it('still escapes the five predefined entities', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
  it('omits data-entity-id when the id is not finite', () => {
    expect(entityIdAttr(NaN)).toBe('');
    expect(entityIdAttr(Infinity)).toBe('');
    expect(entityIdAttr(7)).toBe(' data-entity-id="7"');
    expect(exportToSVG(drawing('IfcWall', NaN), {})).not.toMatch(/NaN/);
  });
  it('title block geometry never prints NaN or Infinity', () => {
    const b = { ...block('v'), widthMm: NaN };
    const { svgElements } = renderTitleBlock(b, { x: 0, y: 0, width: 420, height: 297 }, []);
    expect(svgElements).not.toMatch(/NaN|Infinity/);
  });
  it('svgNum maps non-finite to 0', () => {
    expect(svgNum(NaN)).toBe('0');
    expect(svgNum(1.23456, 2)).toBe('1.23');
  });
});
