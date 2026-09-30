/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { aggregate } from './aggregate.js';
import { elementsDataset } from './elements-dataset.js';
import { buildEChartsOption } from './echarts-option.js';
import { renderChartSvg } from './render-svg.js';

describe('Resized legends with multiline IFC names (#6546 review)', () => {
  it('keeps actual parsed element names intact while rendered legend glyphs fit above the plot', async () => {
    // Derived boundary fixture: the committed SketchUp 2024 / IFC-manager 5.3.3
    // sample keeps its geometry and relationships. Only #262's Name changes;
    // the exporter did not originally emit this multiline name.
    const source = await readFile(new URL('../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url), 'utf8');
    const derived = source.replace("#262=IFCWALL('1AQAupaRP1txwK1AGiN61V',#1,'house - outer wall - house right front'",
      "#262=IFCWALL('1AQAupaRP1txwK1AGiN61V',#1,'Fire\\X2\\000A\\X0\\rating\\X2\\000D000A\\X0\\approved'");
    const bytes = new TextEncoder().encode(derived);
    const store = await new IfcParser().parseColumnar(bytes.buffer);
    const dataset = elementsDataset([{ store, toGlobalId: (id) => id, name: 'derived-sketchup.ifc', include: new Set([262]) }]);
    const aggregation = aggregate({ id: 'multiline', title: 'Wall names', source: 'elements', type: 'stackedBar',
      dimension: 'IfcType', stackBy: 'Name', measure: { agg: 'count' } }, dataset);
    expect(aggregation.total).toBe(1);
    expect(aggregation.series[0].label).toBe('Fire\nrating\r\napproved');
    const pie = aggregate({ id: 'default-pie', title: 'Wall names', source: 'elements', type: 'pie', dimension: 'Name', measure: { agg: 'count' } }, dataset);
    const defaultLegend = buildEChartsOption({ aggregation: pie, width: 220, height: 120, print: true }).legend as { formatter: (name: string) => string };
    expect(defaultLegend.formatter(pie.categories[0].label)).toContain('\n');
    const args = { aggregation, width: 220, height: 120, print: true, showTitle: false, fontSize: 24 };
    const top = (buildEChartsOption(args).grid as { top: number }).top;
    const svg = renderChartSvg(args);
    const legendTexts = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)]
      .filter((match) => /Fire|rating|approved/.test(match[2]));
    expect(legendTexts.length).toBeGreaterThan(0);
    for (const [, attributes] of legendTexts) {
      const translation = attributes.match(/transform="translate\([^ ]+ ([\d.-]+)\)"/);
      const y = attributes.match(/\by="([\d.-]+)"/);
      // zrender positions multiline spans via translate and single-line
      // text directly via y; both are real SVG glyph coordinates.
      expect(translation !== null || y !== null).toBe(true);
      const center = Number(translation?.[1] ?? 0) + Number(y?.[1] ?? 0);
      expect(center + 12).toBeLessThan(top);
    }
    expect(aggregation.series[0].buckets.flatMap((bucket) => [...bucket.ids])).toContain(262);
  });
});
