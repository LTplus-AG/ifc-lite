/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Vector rendering of a chart, off-screen — for the PDF report and for the
 * CLI. ECharts' SVG renderer in SSR mode needs no DOM, so this runs in Node
 * (and in a test) exactly as in the browser. One chart per SVG: ECharts'
 * connected-canvas export is not available on the SVG renderer.
 */
import { init, use } from 'echarts/core';
import { BarChart, PieChart, TreemapChart } from 'echarts/charts';
import { BrushComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { buildEChartsOption, type BuildOptionArgs } from './echarts-option.js';

let registered = false;
/** Register the chart types and components this package uses, once. */
export function registerEChartsModules(): void {
  if (registered) return;
  use([BarChart, PieChart, TreemapChart, BrushComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent, SVGRenderer]);
  registered = true;
}

export interface RenderSvgOptions extends BuildOptionArgs {
  width: number;
  height: number;
}

export function renderChartSvg(options: RenderSvgOptions): string {
  registerEChartsModules();
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: options.width, height: options.height });
  try {
    chart.setOption(buildEChartsOption({ ...options, showTitle: options.showTitle ?? true }));
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}
