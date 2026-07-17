/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SVG exporter: DXF underlay compositing (issue #1782, PR #1794).
 */

import { describe, expect, it } from 'vitest';
import { exportToSVG } from './svg-exporter.js';
import { DEFAULT_SECTION_CONFIG, type Drawing2D } from './types.js';
import type { DxfUnderlay } from './dxf/types.js';

const emptyDrawing = (): Drawing2D => ({
  config: { ...DEFAULT_SECTION_CONFIG, scale: 100 },
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
});

const underlay = (): DxfUnderlay => ({
  name: 'site.dxf',
  unitScale: 1,
  skipped: {},
  warnings: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  layers: [
    {
      name: 'ANNO',
      color: '#112233',
      visible: true,
      fills: [],
      paths: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false }],
      texts: [
        {
          position: { x: 5, y: 5 },
          text: 'Label',
          height: 2,
          dirX: 1,
          dirY: 0,
          align: 'left',
          valign: 'baseline',
        },
      ],
    },
  ],
});

describe('SVGExporter underlays', () => {
  it('scales underlay text height by the placement scale (PR #1794 review)', () => {
    // 1:100 → 10 mm per metre. height 2 m × scale 0.5 → 10 mm font.
    const svg = exportToSVG(emptyDrawing(), {
      underlays: [{ underlay: underlay(), placement: { offsetX: 0, offsetY: 0, rotationDeg: 0, scale: 0.5 } }],
    });
    expect(svg).toContain('font-size="10.000"');
    expect(svg).toContain('stroke="#112233"');
  });

  it('honours per-layer visibility overrides', () => {
    const svg = exportToSVG(emptyDrawing(), {
      underlays: [{ underlay: underlay(), layerVisibility: { ANNO: false } }],
    });
    expect(svg).not.toContain('Label');
    expect(svg).not.toContain('#112233');
  });
});
