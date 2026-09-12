/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export * from './types.js';
export { aggregate, idsForCategories, categoriesForIds, isoWeekKey, sturgesBins, type AggregateOptions, type AggregateResult } from './aggregate.js';
export { assignColors, emptyPalette, paletteColor, OTHER_BUCKET_KEY, OTHER_BUCKET_COLOR, type PaletteAssignment } from './palette.js';
export { buildEChartsOption, DEFAULT_THEME, type ChartTheme, type BuildOptionArgs, type EChartsOptionObject } from './echarts-option.js';
export { renderChartSvg, registerEChartsModules, type RenderSvgOptions } from './render-svg.js';
export { validateDashboardSpec, isDashboardSpec, isReportSpec, type DashboardValidationError } from './validate.js';
export { elementsDataset, ELEMENT_COLUMNS, ELEMENT_DATASET_COLUMNS, type ElementsDatasetModel, type ElementsStore, type ElementsEntityTable } from './elements-dataset.js';
