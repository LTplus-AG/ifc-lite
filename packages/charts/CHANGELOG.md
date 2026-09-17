# @ifc-lite/charts

## 0.3.0

### Minor Changes

- [#4891](https://github.com/LTplus-AG/ifc-lite/pull/4891) [`cd4ee9e`](https://github.com/LTplus-AG/ifc-lite/commit/cd4ee9e6ddb7089babde6e6e38c3dc0877e95b16) Thanks [@louistrue](https://github.com/louistrue)! - Element chart fields cover every IFC field family: `ElementFieldBinding` adds `quantity` (an `IfcElementQuantity` quantity, numeric in the project unit), `material` (associated material names), `classification` (reference identification, for any or one classification system), `type` (the defining `IfcTypeObject` name) and `spatial` (the containing `Container` / `Building` / `Site` / `Project`), with matching column identities, labels and dashboard validation.

- [#4889](https://github.com/LTplus-AG/ifc-lite/pull/4889) [`f24aff9`](https://github.com/LTplus-AG/ifc-lite/commit/f24aff9a7f7685af2cdf0230fe4c712d7dc37940) Thanks [@louistrue](https://github.com/louistrue)! - Let element charts bind to an exact IFC attribute or property, persist the field interpretation, normalize scalar values for aggregation, and report missing sum contributions. Resolve named attributes across every bundled IFC schema so IFC2X3-only and IFC4X3-only classes participate too (`EntityNode.allAttributes()` now consults the store's own schema version). On-demand property extraction reports a property's explicit `Unit` as `unit` plus `unitSiScale`; an unresolvable unit reference is reported as `#<id>` with no scale instead of being dropped.

### Patch Changes

- Updated dependencies [[`37a5949`](https://github.com/LTplus-AG/ifc-lite/commit/37a5949b1ed3786b52602b62d04bf1ac451844b3), [`f24aff9`](https://github.com/LTplus-AG/ifc-lite/commit/f24aff9a7f7685af2cdf0230fe4c712d7dc37940)]:
  - @ifc-lite/data@4.5.0

## 0.2.1

### Patch Changes

- [#4853](https://github.com/LTplus-AG/ifc-lite/pull/4853) [`3d68de9`](https://github.com/LTplus-AG/ifc-lite/commit/3d68de95ba3cb19921623873b9d70a6e17bcc836) Thanks [@louistrue](https://github.com/louistrue)! - Expose synthetic top-N Other bucket identity so consumers can distinguish it from literal category values with the same key.

## 0.2.0

### Minor Changes

- [#4569](https://github.com/LTplus-AG/ifc-lite/pull/4569) [`8d8f484`](https://github.com/LTplus-AG/ifc-lite/commit/8d8f484834fd808201b0dcedbc6df32d1d6daeb7) Thanks [@louistrue](https://github.com/louistrue)! - New package: headless chart data binding for the viewer's charts panel ([#3944](https://github.com/LTplus-AG/ifc-lite/issues/3944)). `aggregate` buckets a dataset by a spec (count / sum, stacked, topN + Other, histogram bins, ISO-week timelines, cross-filter slice) while keeping every bucket's element ids, so a chart click maps to elements and a 3D selection maps back to buckets; `elementsDataset` reads IfcType / Storey / Model / Name straight off a model's entity table; `buildEChartsOption` and `renderChartSvg` (ECharts SSR, no DOM) render it; `validateDashboardSpec` checks saved dashboards and report templates.
