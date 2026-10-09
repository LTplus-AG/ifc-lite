/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { canonicalClasses } from './artifact-rules';
import { modelSchemaIndex } from './model-schema';
import { wallListResponseProfile } from './list-proposal';
import { classCountResponseProfile } from './chart-proposal';
import type { ArtifactPreset } from './artifact-preset';

/** Missing, partial or ambiguous task inputs retain the prose guidance. */
export async function artifactPresetProfile(preset: ArtifactPreset, state: ViewerState, signal: AbortSignal) {
  let index;
  try { index = await modelSchemaIndex(state, signal); }
  catch (error) {
    if (signal.aborted) throw error;
    console.warn('[Assistant] Native artifact preset profile unavailable', error);
    return null;
  }
  if (!index.models.some(model => model.elements > 0)) return null;
  if (preset === 'ifc-class-count-chart') return { schema: classCountResponseProfile(),
    guidance: 'This explicit preset requests one native chart.proposal: a whole-model bar chart counting by IfcType. Return the exact supplied profile; optional fields are omitted.' };
  if (index.partial) return null;
  const wallClasses = new Set(canonicalClasses(['IfcWall']));
  const onWalls = [...index.fields.values()].filter(field => field.byClass
    && [...field.byClass].some(([name, count]) => count > 0 && wallClasses.has(name)));
  const areas = onWalls.filter(field => field.kind === 'quantity' && field.name === 'NetSideArea');
  const ratings = onWalls.filter(field => field.kind === 'property' && field.name === 'FireRating');
  if (areas.length !== 1 || ratings.length !== 1) return null;
  return { schema: wallListResponseProfile(areas[0], ratings[0]),
    guidance: 'This explicit preset requests one native list.proposal: IfcWall, with area and fire-rating columns from the exact native fields in the supplied profile. Return both distinct columns; optional fields are omitted. Missing per-wall values remain native review gaps, never invented.' };
}
