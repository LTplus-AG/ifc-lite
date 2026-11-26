/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `model_anonymize` (#2934): a seed selection, expanded by relationship
 * context, exported as a STEP file with every project-identifying signal
 * removed while geometry-relevant transformations survive. Thin wrapper over
 * `@ifc-lite/export`'s `collectRelatedEntities` / `exportAnonymizedSubset`,
 * the same two functions `ifc-lite anonymize` and the viewer dialog call.
 */

import { writeFile } from 'node:fs/promises';
import { collectRelatedEntities, exportAnonymizedSubset, type RelatedEntityOptions } from '@ifc-lite/export';
import type { Tool } from './types.js';
import { fmtInt, okResult, resolveGlobalIds } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { resolveSafePath } from '../safe-path.js';
import type { LoadedModel, ToolContext } from '../context.js';
import { FILE_WRITE_ANNOTATIONS, fileOutputSchema, invalid, nonBlank, optionalOutputPath, withIfcPrefix, requireDistinctPaths, requireNoPendingEdits, resolveStepModel, stringList, throwIfCancelled, writeSidecar } from './transform-schema.js';

/** Each relationship the walk follows, with the setting it takes when on (when off: false or 'none'). */
const FOLLOWED = {
  IfcRelVoidsElement: true,
  IfcRelFillsElement: true,
  IfcRelDefinesByType: true,
  IfcRelAssociatesMaterial: true,
  IfcRelAggregates: 'both',
  IfcRelNests: 'down',
} as const;
const RELATIONSHIPS = Object.keys(FOLLOWED);

/** Seeds for `model_anonymize`: every selector unioned, each failing loudly on zero matches. */
function anonymizeSeeds(m: LoadedModel, input: Record<string, unknown>): Set<number> {
  const seeds = new Set<number>();
  for (const id of (input.express_ids as number[] | undefined) ?? []) {
    if (!m.bim.entity({ modelId: m.id, expressId: id })) {
      throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `express_ids: entity #${id} not found.` });
    }
    seeds.add(id);
  }
  const globalIds = nonBlank(input.global_ids as string[] | undefined);
  const carriers = resolveGlobalIds(m, globalIds);
  for (const g of globalIds) {
    const ids = carriers.get(g);
    if (!ids) throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `global_ids: GlobalId ${g} not found.` });
    for (const id of ids) seeds.add(id);
  }
  for (const raw of (input.types as string[] | undefined) ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const type = withIfcPrefix(trimmed);
    const matched = m.bim.query().byType(type).toArray();
    if (matched.length === 0) throw invalid(`types: no ${type} entities.`);
    for (const e of matched) seeds.add(e.ref.expressId);
  }
  const key = typeof input.storey === 'string' ? input.storey.trim() : '';
  if (typeof input.storey === 'string' && !key) throw invalid('storey must not be blank.');
  if (key) {
    const id = key.replace(/^#/, '');
    const storeys = m.bim.storeys();
    // An explicit '#id' is an id only, never a name fragment.
    const fragment = key.startsWith('#') ? [] : storeys.filter((s) => s.name?.trim().toLowerCase().includes(key.toLowerCase()));
    const byId = storeys.find((s) => s.globalId === key) ?? storeys.find((s) => String(s.ref.expressId) === id);
    const named = storeys.filter((s) => s.name?.trim() === key);
    // A bare number that is one storey's id and another storey's name is ambiguous.
    if (byId && /^\d+$/.test(key) && named.some((s) => s !== byId)) {
      throw invalid(`storey: '${key}' is storey #${key} and the name of another storey; pass #${key} or a GlobalId.`);
    }
    if (!byId && named.length > 1) throw invalid(`storey: ${named.length} storeys are named '${key}'; pass a GlobalId or express id.`);
    const exact = byId ?? named[0];
    if (!exact && fragment.length > 1) throw invalid(`storey: '${key}' matches ${fragment.map((s) => s.name).join(', ')}; name one exactly.`);
    const storey = exact ?? fragment[0];
    if (!storey) throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `storey: ${key} not found (available: ${storeys.map((s) => s.name).filter(Boolean).join(', ') || 'none'}).` });
    const contained = m.bim.contains(storey.ref);
    if (contained.length === 0) throw invalid(`storey: ${key} contains nothing.`);
    for (const e of contained) seeds.add(e.ref.expressId);
  }
  return seeds;
}

async function runAnonymize(m: LoadedModel, input: Record<string, unknown>, ctx: ToolContext) {
  const filePath = await resolveSafePath(input.file_path, ctx, 'write');
  const guidMapPath = await optionalOutputPath(input, 'guid_map_path', ctx);
  requireDistinctPaths(filePath, guidMapPath, 'guid_map_path');
  // After the awaits above: an edit queued while they ran must still refuse the call.
  // Nothing below awaits until the export is written.
  requireNoPendingEdits(m, 'model_anonymize');
  const seeds = anonymizeSeeds(m, input);
  if (seeds.size === 0) throw invalid('Select something: express_ids, global_ids, types or storey.');
  const keepPsets = input.keep_psets === true;
  const off = new Set((input.exclude_relationships as string[] | undefined) ?? []);
  const followed = Object.fromEntries(
    Object.entries(FOLLOWED).map(([rel, on]) => [rel, off.has(rel) ? (on === true ? false : 'none') : on]),
  ) as RelatedEntityOptions;
  const related = collectRelatedEntities(m.store, seeds, {
    ...followed,
    IfcRelConnectsPathElementsDepth: (input.connect_depth as number | undefined) ?? 0,
    // Keeping psets needs the walk to reach them too, as in the CLI.
    IfcRelDefinesByProperties: keepPsets,
  });
  let result: ReturnType<typeof exportAnonymizedSubset>;
  try {
    // No `filename`: the output path often carries the project name this strips.
    result = exportAnonymizedSubset(m.store, related.all, {
      keepPropertySets: keepPsets,
      pseudonymizeNames: input.keep_names !== true,
      pseudonymizeAllNames: input.keep_other_names !== true,
      neutralizeCurrency: input.keep_currency !== true,
    });
  } catch (err) {
    throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: (err as Error).message });
  }
  throwIfCancelled(ctx);
  await writeFile(filePath, result.content);
  // Owner-only: the map reverses the anonymization.
  if (guidMapPath) await writeSidecar(filePath, guidMapPath, JSON.stringify(Object.fromEntries(result.guidMap), null, 2), 0o600);
  const warnings = [...result.stats.warnings];
  if (related.truncated) warnings.unshift('The related-entity walk hit its work budget; the subset may be incomplete.');
  return okResult(
    `Anonymized ${seeds.size} seed(s): ${fmtInt(related.all.size)} related, ${fmtInt(result.stats.entityCount)} exported to ${filePath}.` +
      (guidMapPath ? ` GUID map at ${guidMapPath} links back to the source; do not share it with the file.` : '') +
      (warnings.length > 0 ? ` Warnings: ${warnings.join('; ')}` : ''),
    {
      filePath,
      bytes: result.content.length,
      seedCount: seeds.size,
      includedCount: related.all.size,
      entityCount: result.stats.entityCount,
      truncated: related.truncated,
      guidMapPath,
      warnings,
    },
  );
}

export const modelAnonymize: Tool = {
  name: 'model_anonymize',
  title: 'Anonymized subset export',
  description:
    'Anonymize, scrub or redact: export selected entities plus their relationship context (hosts, openings, types, materials, aggregates, spatial chain) as an IFC with names, GlobalIds, owner history, property sets and currency neutralised, so a bug reproduction can be shared without the source model. Geometry-relevant placements survive. Selectors are unioned and each must match.',
  scope: 'export',
  // Fresh random GlobalIds and a timestamp each run.
  annotations: { ...FILE_WRITE_ANNOTATIONS, idempotentHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string', description: 'Source model; optional when one model is loaded. Must have no unsaved edits.' },
      file_path: { type: 'string', description: 'Output .ifc path, inside the allowed paths.' },
      express_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Seed entities by express id.' },
      global_ids: { ...stringList, description: 'Seed entities by GlobalId.' },
      types: { ...stringList, description: 'Every entity of these IFC types.' },
      storey: { type: 'string', minLength: 1, description: 'Every entity contained in this storey: GlobalId, #id, exact name, or a name fragment that matches exactly one storey. Ambiguous names are refused.' },
      exclude_relationships: { type: 'array', items: { type: 'string', enum: RELATIONSHIPS }, description: 'Relationships not to follow when expanding the seeds.' },
      connect_depth: { type: 'integer', minimum: 0, description: 'Also follow IfcRelConnectsPathElements this many hops (default 0).' },
      keep_psets: { type: 'boolean', description: 'Keep property sets instead of clearing them.' },
      keep_names: { type: 'boolean', description: 'Keep IfcRoot Name, LongName, Description and Tag as authored.' },
      keep_other_names: { type: 'boolean', description: 'Keep ObjectType, Phase and non-IfcRoot names (styles, materials, layers, profiles).' },
      keep_currency: { type: 'boolean', description: 'Keep IfcMonetaryUnit.Currency instead of USD.' },
      guid_map_path: { type: 'string', description: 'Also write a JSON map from original to new GlobalIds. It identifies the source: keep it apart from the output.' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  outputSchema: fileOutputSchema({
    seedCount: { type: 'integer' },
    includedCount: { type: 'integer' },
    entityCount: { type: 'integer' },
    truncated: { type: 'boolean', description: 'The relationship walk hit its work budget; the subset may be incomplete.' },
    guidMapPath: { type: ['string', 'null'] },
    warnings: { type: 'array', items: { type: 'string' } },
  }),
  handler(input, ctx) {
    return runAnonymize(resolveStepModel(ctx, input.model_id as string | undefined, 'model_anonymize'), input, ctx);
  },
};
