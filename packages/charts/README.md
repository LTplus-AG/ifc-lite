# @ifc-lite/charts

Headless chart data binding for IFC models. A chart is a **dataset** (rows that each carry the renderer ids of the elements they stand for) plus a **spec** (what to bucket by, what to measure). `aggregate` keeps every bucket's member ids, which is what makes a chart bidirectional with a 3D view: a bar is a set of element ids, and a 3D selection is a set of buckets. Rendering is Apache ECharts — an option builder for an on-screen chart and an SVG renderer that runs without a DOM (Node, CLI, PDF export).

## Install

```bash
npm install @ifc-lite/charts
```

## Usage

```ts
import { aggregate, elementsDataset, idsForCategories, categoriesForIds, renderChartSvg } from '@ifc-lite/charts';
import type { ChartSpec } from '@ifc-lite/charts';

// One row per element instance with IfcType / Storey / Model / Name, straight
// off the columnar entity table; `idOffset` is the model's slot in a federation.
const dataset = elementsDataset([{ store, idOffset: 0, name: 'office.ifc' }]);

const spec: ChartSpec = {
  id: 'by-type', title: 'Elements by type', source: 'elements', type: 'bar',
  dimension: 'IfcType', measure: { agg: 'count' }, topN: 12,
};
const agg = aggregate(spec, dataset);
agg.categories;                     // buckets, largest first, each with `ids: Uint32Array` and a stable colour
idsForCategories(agg, [0]);         // chart click → the element ids to select / isolate / ghost in 3D
categoriesForIds(agg, selectedIds); // 3D selection → { full, partial } bucket indices to highlight in the chart

const svg = renderChartSvg({ aggregation: agg, width: 640, height: 400 }); // vector, for a PDF report
```

## Features

- `aggregate(spec, dataset, { slice, palette })`: count / sum by one dimension, optionally stacked by a second; `topN` + `Other`; histogram bins (Sturges default); ISO-week `timeline` for date columns; a `slice` of ids to cross-filter one chart by another; colours assigned by label and kept across re-aggregations
- `elementsDataset(models)`: the elements source without a query engine — one typed-array pass over the entity table and spatial hierarchy
- `buildEChartsOption` / `renderChartSvg`: ECharts options with persistent multi-select and emphasis blur, and SSR SVG output
- `validateDashboardSpec` / `isDashboardSpec` / `isReportSpec`: structural validation of saved dashboards and report templates (`DashboardSpec`, `ReportSpec`)

Part of the [ifc-lite](https://github.com/LTplus-AG/ifc-lite) monorepo. Licensed under MPL-2.0.
