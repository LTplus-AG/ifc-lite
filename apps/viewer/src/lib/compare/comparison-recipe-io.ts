/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isModelSelector } from '@ifc-lite/flow-nodes';
import type { ComparisonRecipe } from './comparison-recipe';

const MAX_RECIPE_BYTES = 1_000_000;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function selector(value: unknown): boolean {
  if (!record(value) || !isModelSelector(value)) return false;
  if (value.kind === 'slot') return keys(value, ['kind', 'slotId']) && value.slotId.length <= 1000;
  if (value.kind === 'filename') return keys(value, ['kind', 'filename']) && value.filename.length <= 1000;
  return keys(value, ['kind', 'tagName']) && value.tagName.length <= 1000;
}

/** Strict boundary: reports and evidence cannot be mistaken for runnable configuration. */
export function validateComparisonRecipe(value: unknown): ComparisonRecipe {
  if (!record(value) || !keys(value, ['kind', 'version', 'id', 'name', 'base', 'head', 'options'])
    || value.kind !== 'ifc-lite-comparison-recipe' || value.version !== 1) {
    throw new Error('Expected a version 1 comparison recipe, not a completed report.');
  }
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200
    || !selector(value.base) || !selector(value.head)) {
    throw new Error('Comparison recipe requires a name and portable A/B model selectors.');
  }
  const options = value.options;
  if (!record(options) || !keys(options, ['scope', 'excludedTypes', 'matchByContent', 'keyProperty'])
    || !['data', 'geometry', 'both'].includes(String(options.scope))
    || typeof options.matchByContent !== 'boolean'
    || !Array.isArray(options.excludedTypes) || options.excludedTypes.length > 1000
    || !options.excludedTypes.every((v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200)
    || (options.keyProperty !== undefined && (typeof options.keyProperty !== 'string'
      || !options.keyProperty.trim() || options.keyProperty.length > 500))) {
    throw new Error('Comparison recipe contains invalid comparison options.');
  }
  return structuredClone(value) as unknown as ComparisonRecipe;
}

export function readComparisonRecipe(text: string): ComparisonRecipe {
  if (new TextEncoder().encode(text).byteLength > MAX_RECIPE_BYTES) throw new Error('Comparison recipe exceeds 1 MB.');
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    throw new Error('Comparison recipe is not valid JSON.', { cause: error });
  }
  return validateComparisonRecipe(value);
}

export function serializeComparisonRecipe(recipe: ComparisonRecipe): string {
  return JSON.stringify(validateComparisonRecipe(recipe), null, 2);
}
