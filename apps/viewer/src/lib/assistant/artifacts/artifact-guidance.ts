/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provider guidance for native artifact proposals (viewer AI P13): the exact
 * contract, plus a bounded digest of the local model schema index so the
 * answer can use names the loaded models really carry. The index itself stays
 * local; only the digest (at most `DIGEST_LIMIT` characters) is sent.
 */

import type { ViewerState } from '@/store';
import { modelSchemaIndex, type ModelSchemaIndex } from './model-schema';

export const DIGEST_LIMIT = 4000;

export const ARTIFACT_OUTPUT_GUIDANCE =
  'When asked to find elements or build a filter, list, lens or chart, return only one JSON object: '
  + '{"version":1,"kind":"filter.proposal","title":"…","rationale":"…","name":"…","groups":[G]}; '
  + '{"version":1,"kind":"list.proposal","title":"…","list":{"name":"…","entityTypes":["IfcWall"],"groups":[G],"columns":[C],"grouping":{"columnIds":["storey"],"sumColumnIds":["area"]}}}; '
  + '{"version":1,"kind":"lens.proposal","title":"…","lens":{"name":"…","rules":[{"name":"…","groups":[G],"action":"colorize|transparent|hide","color":"#E53935"}]}} '
  + 'or "lens":{"name":"…","autoColor":{"source":"ifcType|material|classification|attribute|property|quantity","psetName":"…","propertyName":"…"}}; '
  + '{"version":1,"kind":"chart.proposal","title":"…","scope":"all|visible|basket","chart":{"type":"bar|pie|treemap|stackedBar|histogram|elementCount",'
  + '"dimension":"IfcType|Storey|Model|Name" or "elementField":F,"measure":{"agg":"count|sum"},"measureField":F (sum only),"filter":{"groups":[G]},"topN":10}}. '
  + 'G = {"combinator":"AND|OR","rules":[R]}; groups OR together. R: {"kind":"ifcType","op":"in|notIn","values":["IfcWall"]} (subclasses included); '
  + '{"kind":"property","setName":"Pset_WallCommon","propertyName":"FireRating","op":"eq|ne|contains|startsWith|gt|lt|isSet|isNotSet","value":"EI60"}; '
  + '{"kind":"quantity","setName":"Qto_WallBaseQuantities","quantityName":"NetSideArea","op":"gt|gte|lt|lte|eq|ne","value":10} (numbers in SI: m, m², m³); '
  + 'storey/predefinedType/globalId {"op":"in","values":[…]}; model {"op":"in|notIn","values":["<a model name listed below>"]}; '
  + 'name/material/type {"op":"eq|contains|startsWith","value":"…"}; '
  + 'attribute {"name":"Description|ObjectType|Tag|LongName|PredefinedType","op","value"}; classification {"system","op","value"}; elevation {"op","value" in m}. '
  + 'C = {"id":"area","source":"attribute|property|quantity|material|classification|spatial|model","psetName":"…","propertyName":"…","label":"…"} '
  + '(attribute names Name, GlobalId, Class, Type, Description, ObjectType, PredefinedType, Tag; spatial propertyName Storey, Building, Site, Project or Container). '
  + 'F = {"kind":"quantity","qsetName","quantityName"}, {"kind":"property","psetName","propertyName"}, {"kind":"attribute","attributeName"}, '
  + '{"kind":"material"}, {"kind":"type"}, {"kind":"classification"} or {"kind":"spatial","level":"Building"}. '
  + 'Filters, lists and lenses run over every loaded model; "this model" is a model rule. They have no "scope": visible and selected '
  + 'are not filter criteria (only a chart scope may be visible or basket), so say that instead of proposing a broader filter. '
  + 'When a request needs what these rules cannot express (a relation between two elements, a distance, a value computed from '
  + 'several fields), answer in prose: say what is unsupported and offer the closest supported proposal; never approximate it silently. '
  + 'Use only class, set, property and model names from the model schema below, exactly as spelled; '
  + 'when the wanted one is missing or ambiguous, say so and name the closest listed ones instead of inventing. '
  + 'The user reviews the matched population, units and denominators before anything is saved.';

function joinBounded(label: string, items: string[], budget: number): string {
  let out = `${label}: `;
  let shown = 0;
  for (const item of items) {
    const next = `${shown > 0 ? ', ' : ''}${item}`;
    if (out.length + next.length > budget) break;
    out += next;
    shown += 1;
  }
  return shown < items.length ? `${out} (+${items.length - shown} more)` : out;
}

/** A bounded, count-ranked digest of the index: classes, then properties, then quantities. */
export function schemaDigest(index: ModelSchemaIndex): string {
  if (index.models.length === 0) return 'Model schema: no model with data is loaded.';
  const byCount = <T extends { count: number }>(items: T[]) => items.sort((a, b) => b.count - a.count);
  const classes = byCount([...index.classes].map(([name, count]) => ({ name, count }))).map((c) => `${c.name} ${c.count}`);
  const fields = byCount([...index.fields.values()]);
  const properties = fields.filter((f) => f.kind === 'property').map((f) => `${f.set}.${f.name} ${f.count}`);
  const quantities = fields.filter((f) => f.kind === 'quantity').map((f) => `${f.set}.${f.name} ${f.count}`);
  const head = `Model schema (exact names; numbers are elements carrying them${index.partial ? '; counts cover the first scanned elements of large models' : ''}). `
    + `Models: ${index.models.map((m) => `${m.name} (${m.elements} elements)`).join(', ')}.`;
  const budget = DIGEST_LIMIT - head.length;
  return [head, joinBounded('Classes', classes, budget * 0.2), joinBounded('Properties', properties, budget * 0.5),
    joinBounded('Quantities', quantities, budget * 0.25)].join('\n');
}

export async function artifactGuidance(state: Pick<ViewerState, 'models' | 'mutationViews' | 'mutationVersion'>, signal?: AbortSignal): Promise<string> {
  let digest: string;
  try {
    digest = schemaDigest(await modelSchemaIndex(state, signal));
  } catch (error) {
    if (signal?.aborted) throw error;
    // The digest only helps the answer; the review's exact-name check still guards every proposal, so the request goes ahead.
    console.warn('[Assistant] Model schema index unavailable for guidance', error);
    digest = 'Model schema: unavailable for the loaded models; ask the user for exact class, set and property names.';
  }
  return `${ARTIFACT_OUTPUT_GUIDANCE}\n${digest}`;
}
