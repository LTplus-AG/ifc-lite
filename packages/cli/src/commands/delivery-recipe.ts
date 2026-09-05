/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The saved recipe `ifc-lite delivery` runs.
 *
 * A recipe is a plain JSON file naming one or more model files and the
 * checks to run against every one of them — `structural` (the same rules
 * `ifc-lite validate` runs) and/or one or more `ids` rule files (the same
 * validator `ifc-lite ids` runs). It exists so a delivery check is a single,
 * versioned, reviewable artifact a team commits and re-runs, rather than a
 * remembered shell invocation.
 *
 * ```json
 * {
 *   "models": ["model.ifc"],
 *   "structural": true,
 *   "ids": ["door-rules.ids"]
 * }
 * ```
 *
 * Every `models`/`ids` path is resolved relative to the DIRECTORY CONTAINING
 * THE RECIPE FILE, not the process's current working directory — a recipe
 * committed alongside its fixtures stays runnable from anywhere.
 *
 * A malformed recipe is a `fatal(...)`, matching every other saved-definition
 * loader in this CLI (`schedule-spec.ts`): not valid JSON, not a JSON object,
 * an unrecognised field, a field of the wrong type, an empty/missing
 * `models` list, or declaring NEITHER `structural: true` NOR a non-empty
 * `ids` list (a recipe with zero applicable checks can never produce a
 * meaningful delivery verdict, so it is rejected up front rather than
 * silently reporting an empty "pass").
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fatal } from '../output.js';

/** The recipe fields as declared in the JSON file (paths not yet resolved). */
export interface DeliveryRecipe {
  models: string[];
  structural: boolean;
  ids: string[];
}

/** A recipe with every `models`/`ids` path resolved to an absolute path. */
export interface ResolvedDeliveryRecipe extends DeliveryRecipe {
  /** Absolute path to the recipe file itself. */
  recipePath: string;
  /** `models`, resolved to absolute paths, in declared order. */
  resolvedModels: string[];
  /** `ids`, resolved to absolute paths, in declared order. */
  resolvedIds: string[];
}

const RECIPE_FIELDS: (keyof DeliveryRecipe)[] = ['models', 'structural', 'ids'];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

/**
 * Load and validate a delivery recipe, resolving every declared path
 * relative to the recipe file's own directory. Every failure mode is a
 * `fatal(...)` with a specific reason — never a silently empty or
 * partially-applied recipe.
 */
export async function loadDeliveryRecipe(path: string): Promise<ResolvedDeliveryRecipe> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    fatal(`Recipe "${path}" could not be read: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    fatal(`Recipe "${path}" is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fatal(`Recipe "${path}" must be a JSON object with "models" and at least one of "structural"/"ids", got ${Array.isArray(parsed) ? 'an array' : typeof parsed}.`);
  }

  const obj = parsed as Record<string, unknown>;

  const unknownKeys = Object.keys(obj).filter(k => !(RECIPE_FIELDS as string[]).includes(k));
  if (unknownKeys.length > 0) {
    fatal(`Recipe "${path}" has unrecognised field(s): ${unknownKeys.join(', ')}. Valid fields: ${RECIPE_FIELDS.join(', ')}.`);
  }

  if (!('models' in obj) || !isStringArray(obj.models) || obj.models.length === 0) {
    fatal(`Recipe "${path}": "models" must be a non-empty array of file paths.`);
  }
  const models = obj.models as string[];

  if ('structural' in obj && typeof obj.structural !== 'boolean') {
    fatal(`Recipe "${path}": "structural" must be a boolean, got ${typeof obj.structural}.`);
  }
  const structural = (obj.structural as boolean | undefined) ?? false;

  if ('ids' in obj && !isStringArray(obj.ids)) {
    fatal(`Recipe "${path}": "ids" must be an array of file paths.`);
  }
  const ids = (obj.ids as string[] | undefined) ?? [];

  if (!structural && ids.length === 0) {
    fatal(`Recipe "${path}" declares no applicable checks: set "structural": true and/or a non-empty "ids" list. A zero-check recipe can never produce a delivery verdict.`);
  }

  // Duplicate model/ids entries are rejected rather than silently
  // deduplicated or run twice under one collapsed key: a repeated path is
  // almost certainly a copy-paste mistake in the recipe, and either
  // response (silent dedup, or a doubled report entry) would misrepresent
  // what the recipe actually says it checks.
  const dupModels = models.filter((m, i) => models.indexOf(m) !== i);
  if (dupModels.length > 0) {
    fatal(`Recipe "${path}": "models" lists the same path more than once: ${[...new Set(dupModels)].join(', ')}.`);
  }
  const dupIds = ids.filter((m, i) => ids.indexOf(m) !== i);
  if (dupIds.length > 0) {
    fatal(`Recipe "${path}": "ids" lists the same path more than once: ${[...new Set(dupIds)].join(', ')}.`);
  }

  const recipePath = resolve(path);
  const baseDir = dirname(recipePath);
  const resolvedModels = models.map(m => resolve(baseDir, m));
  const resolvedIds = ids.map(i => resolve(baseDir, i));

  return { recipePath, models, structural, ids, resolvedModels, resolvedIds };
}
