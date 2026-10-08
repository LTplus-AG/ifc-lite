# @ifc-lite/charts

Headless chart data binding for IFC models. A chart is a **dataset** (rows that each carry the renderer ids of the elements they stand for) plus a **spec** (what to bucket by, what to measure). `aggregate` keeps every bucket's member ids, which is what makes a chart bidirectional with a 3D view: a bar is a set of element ids, and a 3D selection is a set of buckets. Rendering is Apache ECharts — an option builder for an on-screen chart and an SVG renderer that runs without a DOM (Node, CLI, PDF export).

## Install

```bash
npm install @ifc-lite/charts
```

## Usage

```ts
import { aggregate, elementFieldColumnId, elementsDataset, idsForCategories, categoriesForIds, renderChartSvg } from '@ifc-lite/charts';
import type { ChartSpec, ElementFieldBinding } from '@ifc-lite/charts';

// One row per element instance with IfcType / Storey / Model / Name, straight
// off the columnar entity table; `toGlobalId` is the host's own local → renderer id resolver.
const dataset = elementsDataset([{ store, toGlobalId: (id) => id, name: 'office.ifc' }]);

// A host can materialize only the exact IFC fields its saved charts request.
const fireRating: ElementFieldBinding = {
  kind: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating', valueKind: 'category',
};
const withFireRating = elementsDataset(
  [{ store, toGlobalId: (id) => id, name: 'office.ifc', readField: () => null }], // replace with your cached IFC reader
  [fireRating],
);

const spec: ChartSpec = {
  id: 'by-rating', title: 'Walls by fire rating', source: 'elements', type: 'bar',
  elementField: fireRating, dimension: elementFieldColumnId(fireRating), measure: { agg: 'count' }, topN: 12,
};
const agg = aggregate(spec, withFireRating);
agg.categories;                     // buckets, largest first, each with `ids: Uint32Array` and a stable colour
idsForCategories(agg, [0]);         // chart click → the element ids to select / isolate / ghost in 3D
categoriesForIds(agg, selectedIds); // 3D selection → { full, partial } bucket indices to highlight in the chart

const svg = renderChartSvg({ aggregation: agg, width: 640, height: 400 }); // vector, for a PDF report
const compactSvg = renderChartSvg({ aggregation: agg, width: 640, height: 400, print: true, fontSize: 8 });
```

## Features

- `aggregate(spec, dataset, { slice, palette })`: count / sum by one dimension, optionally stacked by a second; `topN` + `Other`; histogram bins (Sturges default); ISO-week `timeline` for date columns; a `slice` of ids to cross-filter one chart by another; colours assigned by label and kept across re-aggregations
- `elementsDataset(models, fields?)`: the elements source without a query engine — one typed-array pass over the entity table and spatial hierarchy, optionally materializing requested IFC fields and live storey labels through host readers
- `elementFieldColumnId` / `elementFieldLabel` / `normalizeElementFieldValue`: collision-free persisted field identities and scalar normalization for IFC attributes, properties, quantities, material, classification, defining type and spatial container (`ElementFieldBinding`)
- `buildEChartsOption` / `renderChartSvg`: ECharts options with persistent multi-select and emphasis blur, and SSR SVG output
- `validateDashboardSpec` / `isDashboardSpec` / `isReportSpec`: structural validation of saved dashboards and report templates (`DashboardSpec`, `ReportSpec`)

Both rendering functions accept an optional `fontSize` (6–24, default 12).
It scales axes, legends, data labels, titles and the count display, including
the text measurements used to fit labels and pack static legends. Unset,
default or invalid values retain the existing typography. `CHART_FONT_SIZE`
exposes the bounds and default; `chartFontScale(fontSize)` gives the shared
ratio for a host's chart headings and surrounding layout.

`ChartSpec.comparisonId?: string` optionally binds a `compare` chart to a
completed saved comparison in the viewer. Validation rejects an empty ID
or a binding on another source. The chart package accepts the resolved
dataset from its host; it does not own or embed the viewer's saved-history
schema. In the viewer, a missing history dependency remains explicitly
unavailable rather than using the latest live result. Unbound existing
comparison charts retain their previous behavior. See the
[saved comparison chart guide](../../docs/guide/charts.md#saved-comparison-charts)
for recorded row semantics, local-history dependencies and 3D limitations.

`ChartSpec.clashReportId?: string` optionally binds a `clash` chart to a saved
clash report in the viewer. Absent means the current clash result, which is
what existing charts read. Validation rejects an empty ID, a binding on
another source, and an element filter (`selector` or `groups`) beside it,
because saved rows carry no element ids; `filter.clashRule` stays valid. As
with `comparisonId`, the host resolves the dataset and this package does not
own the saved report's schema. See the
[saved clash report chart guide](../../docs/guide/charts.md#saved-clash-report-charts).

Part of the [ifc-lite](https://github.com/LTplus-AG/ifc-lite) monorepo. Licensed under MPL-2.0.
