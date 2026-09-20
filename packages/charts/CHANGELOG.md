# @ifc-lite/charts

## 0.4.0

### Minor Changes

- [#4984](https://github.com/LTplus-AG/ifc-lite/pull/4984) [`873a648`](https://github.com/LTplus-AG/ifc-lite/commit/873a6481af34f1a494e9667ab1f77c3328125077) Thanks [@louistrue](https://github.com/louistrue)! - Add a per-chart source filter ([#4946](https://github.com/LTplus-AG/ifc-lite/issues/4946)): `ChartSpec.filter` narrows a chart's rows with the same selector syntax and matching path the search Filter tab uses, on top of the dashboard scope. Applicable to `elements`, `clash`, `schedule` and `ids`; refused on `bcf` and `compare` where a row does not stand for one matchable element. `DashboardSpec.version` moves from 1 to 2 (adds the filter, drops the unused `list` scope kind); `migrateDashboardSpec` upgrades a saved version-1 dashboard on load. The dead `ChartScope.list` scaffold (no resolver was ever wired to it) is removed.

- [#4983](https://github.com/LTplus-AG/ifc-lite/pull/4983) [`427e886`](https://github.com/LTplus-AG/ifc-lite/commit/427e88664b021125bc7f9c07fe1f57f209410ad6) Thanks [@louistrue](https://github.com/louistrue)! - **charts / document**: printed and previewed charts stop clipping their legend and stop being stuck at one fixed size ([#4940](https://github.com/LTplus-AG/ifc-lite/issues/4940)). `renderChartSvg`/`buildEChartsOption` take a `print?: boolean` option: SSR SVG (the PDF and the document preview, which render statically, not through the interactive canvas) truncate every legend label past ~24 characters with a tooltip for the full name, and a pie's legend switches from `type: 'scroll'` — which has nothing to scroll in a static image and clips instead — to a fixed, wrapped `type: 'plain'` legend under a slightly smaller pie, sized from the room left after reserving up to 4 legend rows; a pie with more categories than fit those rows keeps every slice but omits the extra legend entries (the same trade-off label truncation already makes for long names), and hides its own per-slice callout labels/leader lines once it is this crowded, since the legend already names each slice. A document's chart block now takes an optional `height` (120-600pt, default 220) and both chart and image blocks take `width: 'full' | 'half'`; two consecutive `'half'` chart/image blocks share one row in the compose layout and the preview. A new `spacer` block adds blank vertical space between blocks, and three text styles (`subheading`, `caption`, `small`) join `title`/`heading`/`body`. `.ifclite-document.json` moves to `version: 2`; `migrateDocumentSpec` upgrades a `version: 1` file in place, and `validateDocumentSpec` accepts only `version: 2` going forward.

### Patch Changes

- Updated dependencies [[`d38af5a`](https://github.com/LTplus-AG/ifc-lite/commit/d38af5afd36f12329fe6f33bf905d28fca65ba43), [`e1ace4f`](https://github.com/LTplus-AG/ifc-lite/commit/e1ace4f05a45a252d502bf72a506336185d2b157), [`ab8380e`](https://github.com/LTplus-AG/ifc-lite/commit/ab8380e6b9edf1ca1f05abf343ae6040ac8aee77), [`e211790`](https://github.com/LTplus-AG/ifc-lite/commit/e211790ff4d7070d908fb519652158089652dd9c)]:
  - @ifc-lite/data@5.0.0

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
