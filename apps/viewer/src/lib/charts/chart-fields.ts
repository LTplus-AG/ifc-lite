/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { elementFieldColumnId, type ChartSpec, type ElementFieldBinding } from '@ifc-lite/charts';

/** Every IFC column a set of saved element charts needs, including independent measures. */
export function chartElementFields(charts: readonly ChartSpec[]): ElementFieldBinding[] {
  const fields = charts.filter((chart) => chart.source === 'elements')
    .flatMap((chart) => [chart.elementField, chart.measureField].filter((field): field is ElementFieldBinding => field !== undefined));
  return [...new Map(fields.map((field) => [elementFieldColumnId(field), field])).values()];
}
