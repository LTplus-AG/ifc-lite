/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tree-shaken ECharts build the viewer draws with. STATIC named imports
 * from the `echarts/*` barrels are what let the bundler drop the chart types
 * and components the panel never uses; a dynamic `import('echarts/charts')`
 * asks for the whole namespace and ships all of it. `useEChart` reaches this
 * module through one `import()`, so none of it is in the first paint.
 */
import { init, use, type EChartsType } from 'echarts/core';
import { BarChart, PieChart, TreemapChart } from 'echarts/charts';
import { BrushComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

use([BarChart, PieChart, TreemapChart, GridComponent, TooltipComponent, LegendComponent, BrushComponent, CanvasRenderer]);

export function createChart(el: HTMLElement): EChartsType {
  return init(el, undefined, { renderer: 'canvas' });
}
