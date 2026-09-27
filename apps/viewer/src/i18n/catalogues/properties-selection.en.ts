/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Properties panel value copy and multi-selection summary (#5900): the copy
 * button every attribute / property / quantity row carries, its toasts, and
 * the summary shown instead of one element when several are selected.
 * Attribute, property and set names, values and model names stay model
 * content.
 */
export const propertiesSelectionEn = {
  'properties.copy.valueLabel': 'Copy {name}',
  'properties.copy.valueTooltip': 'Copy {name} (Shift or hold: copy name=value)',
  'properties.copy.copied': 'Copied to clipboard',
  'properties.copy.failed': 'Could not copy to the clipboard',

  'properties.summary.elementCount': { one: '{countDisplay} element', other: '{countDisplay} elements' },
  'properties.summary.byClassHeading': 'By class',
  'properties.summary.byModelHeading': 'By model',
  'properties.summary.elementsHeading': 'Elements',
  'properties.summary.attributesHeading': 'Shared attributes',
  'properties.summary.propertiesHeading': 'Shared properties',
  'properties.summary.quantitiesHeading': 'Shared quantities',
  'properties.summary.varies': { one: '(varies: {countDisplay} value)', other: '(varies: {countDisplay} values)' },
  'properties.summary.noShared': 'The selected elements share no properties or quantities',
  'properties.summary.selectOnly': 'Select only {name}',
  'properties.summary.moreElements': { one: '{countDisplay} more element', other: '{countDisplay} more elements' },
  'properties.summary.valuesCapped': 'Values compared across the first {limit} of {total} elements',
} as const satisfies Record<string, TranslationValue>;
