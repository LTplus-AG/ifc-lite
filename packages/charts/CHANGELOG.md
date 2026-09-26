# @ifc-lite/charts

## 0.6.2

### Patch Changes

- Updated dependencies [[`8901816`](https://github.com/LTplus-AG/ifc-lite/commit/8901816fa9171b1af0a9af5036105db0fa72cb24), [`236b076`](https://github.com/LTplus-AG/ifc-lite/commit/236b076ca7ee967691380335b4637a5be3c61562)]:
  - @ifc-lite/data@6.1.0
  - @ifc-lite/rules@0.5.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`ccc491e`](https://github.com/LTplus-AG/ifc-lite/commit/ccc491efac18ce496af47c91b1ef4fc04ebecca5), [`7215c2a`](https://github.com/LTplus-AG/ifc-lite/commit/7215c2a9344ede37c90680e1eb2a6c2b70c0ee3d), [`5c02af8`](https://github.com/LTplus-AG/ifc-lite/commit/5c02af8b7fda4d2fe53f79d3f00b9d192fc664d9)]:
  - @ifc-lite/data@6.0.0
  - @ifc-lite/rules@0.4.0

## 0.6.0

### Minor Changes

- [#5176](https://github.com/LTplus-AG/ifc-lite/pull/5176) [`aaaa9c6`](https://github.com/LTplus-AG/ifc-lite/commit/aaaa9c65de99ee25cdd95a34a0c234405576e8bd) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `ChartSourceFilter` gains an optional `clashRule` field so a `clash` chart can be built from ONE detection rule/run instead of every rule of the current clash result being counted together ([#5156](https://github.com/LTplus-AG/ifc-lite/issues/5156)). Absent means every rule, same as before; `validate.ts` rejects it on any source other than `clash`.

- [#5368](https://github.com/LTplus-AG/ifc-lite/pull/5368) [`e8e5813`](https://github.com/LTplus-AG/ifc-lite/commit/e8e58133abd2bd1a6a1f42bc3f8f6c9df828464a) Thanks [@louistrue](https://github.com/louistrue)! - Allow chart source filters to store filter rule groups, including model tags, alongside existing selector filters ([#4946](https://github.com/LTplus-AG/ifc-lite/issues/4946)).

- [#5375](https://github.com/LTplus-AG/ifc-lite/pull/5375) [`6198d55`](https://github.com/LTplus-AG/ifc-lite/commit/6198d55d1fd38e02c91e48bf689ab9127fbdf2f8) Thanks [@louistrue](https://github.com/louistrue)! - Allow charts to sum an IFC numeric field independently of the grouping field and validate copied chart specs consistently

### Patch Changes

- Updated dependencies [[`83284a9`](https://github.com/LTplus-AG/ifc-lite/commit/83284a947d9adb9e1ece28f9d5ee7166722be1e5), [`52d30de`](https://github.com/LTplus-AG/ifc-lite/commit/52d30de0ae3fc8ef6322191bd1831483b93d485f), [`617da29`](https://github.com/LTplus-AG/ifc-lite/commit/617da29bc17326105dd1143385c967210e529a43), [`dabc489`](https://github.com/LTplus-AG/ifc-lite/commit/dabc48987aca1392685218dd31641f8dbadf9590), [`60f70f9`](https://github.com/LTplus-AG/ifc-lite/commit/60f70f93c9cdf9948f1a7325efb1e157a09d3a60), [`29688df`](https://github.com/LTplus-AG/ifc-lite/commit/29688df238998baea77b3fe55afe113b40c13eae), [`b9206c9`](https://github.com/LTplus-AG/ifc-lite/commit/b9206c94dceef0041dcf37e4cfe44cf09f4b4d7b), [`70ad6a7`](https://github.com/LTplus-AG/ifc-lite/commit/70ad6a7c77b73d6a04a7d842a64ce4a014451e68), [`79716f9`](https://github.com/LTplus-AG/ifc-lite/commit/79716f9828e4f57bedeaef66292233806b15edf7), [`610d7f2`](https://github.com/LTplus-AG/ifc-lite/commit/610d7f29708bb4febf7dd9a8d716a8e5e0b4dba4), [`94bd946`](https://github.com/LTplus-AG/ifc-lite/commit/94bd946d7a4e9ab98c5e9a950fa6e8a8e39b5316), [`7e8d225`](https://github.com/LTplus-AG/ifc-lite/commit/7e8d225273d3f20d727dac879e31ac4e6ce165bb), [`fc6f49c`](https://github.com/LTplus-AG/ifc-lite/commit/fc6f49c79485640073b924df86a0973c691b7a5f), [`6314cbe`](https://github.com/LTplus-AG/ifc-lite/commit/6314cbed245efb39552487307be55b6884fd0b97), [`fbda35b`](https://github.com/LTplus-AG/ifc-lite/commit/fbda35b5bbf5475fe99d85301aff728624058f8d), [`07ed0dd`](https://github.com/LTplus-AG/ifc-lite/commit/07ed0ddaf4e527f1fff3704cc0d36e700fcde1a7), [`0d9cbc0`](https://github.com/LTplus-AG/ifc-lite/commit/0d9cbc0072baa634923623c6772500d57a63f412), [`4175a1e`](https://github.com/LTplus-AG/ifc-lite/commit/4175a1e0e8b055de2a5c58288a87b84c3c85c610)]:
  - @ifc-lite/data@5.1.0
  - @ifc-lite/rules@0.3.0

## 0.5.0

### Minor Changes

- [#5151](https://github.com/LTplus-AG/ifc-lite/pull/5151) [`b785770`](https://github.com/LTplus-AG/ifc-lite/commit/b7857709a31f958601f1c4c9af09e5a95f81300e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add Element Count chart type. Displays the total count of elements as a numeric KPI-style readout. The chart reuses the existing source-filter mechanism and renders a single aggregated value as text.
  
  `ChartSpec` is now a discriminated union on `type`: every chart type but `elementCount` still requires `dimension`, and `elementCount` must omit it entirely (no `dimension: ''` sentinel). `aggregate()` always counts matching rows for `elementCount` regardless of `measure`, and `validateDashboardSpec()` rejects an `elementCount` chart that carries a `dimension` or a non-`count` measure, so a chart switched from a sum-measured type can no longer render a stale total of zero.

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
