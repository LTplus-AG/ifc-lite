/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { collectRelatedEntities, type RelatedEntityOptions } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { ensureModelExportReady } from '@/services/desktop-export';
import { lockedAnonymizedIds, includedAnonymizedIds } from '@/lib/export/anonymized-native-set';
import { produceAnonymizedExport } from '@/components/viewer/anonymized-export/anonymized-export-run';
import { toAnonymizeOptions, type AnonymizeToggles } from '@/components/viewer/anonymized-export/AnonymizationOptionsPanel';
import { viewerOperation } from './contract';
import { exportMetadata } from './exports-common';
import { MAX_RESULT_BYTES, resultBytes } from './result-limit';
import { nativeExportTarget, nativeExportGuard, nativeArtifact, targetSchema } from './export-native-runtime';
interface Input { target_model_id: string; seed_ids: number[]; excluded_ids: number[]; excluded_types: string[]; relations: Required<RelatedEntityOptions>; anonymize: AnonymizeToggles; file_stem: string }
const MAX_IDS = 100000;
const NARROW = 'Narrow the selection or exclude types.';
/** A refusal the caller can tell apart by details.reason: the membership cap or the preview size (#10794). */
function tooLarge(reason: 'member-cap' | 'preview-size', message: string, details: Record<string, number>): never {
  throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `${message} ${NARROW}`, details: { reason, ...details } });
}
const ids = { type: 'array' as const, maxItems: MAX_IDS, uniqueItems: true as const, items: { type: 'integer' as const, minimum: 1 } };
const direction = { type: 'string' as const, enum: ['up', 'down', 'both', 'none'] as const };
const bool = { type: 'boolean' as const };
const schema = { type: 'object', properties: {
  target_model_id: targetSchema, seed_ids: { ...ids, minItems: 1 }, excluded_ids: ids, excluded_types: { type: 'array', maxItems: 1000, uniqueItems: true as const, items: { type: 'string', pattern: '^Ifc[A-Za-z0-9]+$' } }, file_stem: { type: 'string', minLength: 1, maxLength: 200 },
  relations: { type: 'object', properties: { IfcRelVoidsElement: bool, IfcRelFillsElement: bool, IfcRelAggregates: direction, IfcRelNests: direction, IfcRelDefinesByType: bool, IfcRelAssociatesMaterial: bool, IfcRelContainedInSpatialStructure: bool, IfcRelDefinesByProperties: bool, IfcRelConnectsPathElementsDepth: { type: 'integer', minimum: 0, maximum: 3 } }, required: ['IfcRelVoidsElement', 'IfcRelFillsElement', 'IfcRelAggregates', 'IfcRelNests', 'IfcRelDefinesByType', 'IfcRelAssociatesMaterial', 'IfcRelContainedInSpatialStructure', 'IfcRelDefinesByProperties', 'IfcRelConnectsPathElementsDepth'], additionalProperties: false },
  anonymize: { type: 'object', properties: { names: bool, otherNames: bool, globalIds: bool, propertySets: bool, rootPlacementPosition: bool, georeferencing: bool, currency: bool }, required: ['names', 'otherNames', 'globalIds', 'propertySets', 'rootPlacementPosition', 'georeferencing', 'currency'], additionalProperties: false },
}, required: ['target_model_id', 'seed_ids', 'excluded_ids', 'excluded_types', 'relations', 'anonymize', 'file_stem'], additionalProperties: false } satisfies JSONSchemaType<Input>;
async function prepare(i: Input, check: () => void) {
  const model = nativeExportTarget(i.target_model_id); const store = await ensureModelExportReady(model.id); check(); if (!store) throw new Error('Native anonymization source store is unavailable.');
  if (!store.source?.byteLength) throw new Error('Native anonymization requires original IFC STEP source bytes.');
  const view = useViewerStore.getState().getMutationView(model.id);
  // @raw-entity-enumeration-ok native anonymization exports source records; overlay-created seeds are refused on this same line
  if (i.seed_ids.some(id => view?.hasNewEntity(id) || store.entityIndex.byId.get(id) === undefined)) throw new Error('Native anonymization reads source records; overlay-created or unknown seeds cannot be exported.');
  if (i.anonymize.propertySets && i.relations.IfcRelDefinesByProperties) throw new Error('Native property-set anonymization and source property-set expansion are coupled; turn expansion off or explicitly keep property sets.');
  const related = collectRelatedEntities(store, i.seed_ids, i.relations); const locked = lockedAnonymizedIds(related, i.seed_ids);
  const typeOf = new Map<number, string>(); for (const id of related.all) { const name = store.entities.getTypeName(id); if (!name.startsWith('IfcRel')) typeOf.set(id, name); }
  if (i.excluded_ids.some(id => !related.all.has(id) || locked.has(id))) throw new Error('Unknown or locked spatial/seed exclusion.');
  const included = includedAnonymizedIds(related, locked, new Set(i.excluded_ids), new Set(i.excluded_types), typeOf);
  // The preview and the export both carry the membership as an id list, so above the cap neither could ever run (#10794).
  const size = Math.max(included.size, locked.size);
  if (size > MAX_IDS) tooLarge('member-cap', `The selection expands to ${size} entities, above the ${MAX_IDS} an anonymized export can carry.`, { members: size, limit: MAX_IDS });
  check(); return { store, related, locked, included };
}
const previewSchema = { type: 'object', properties: { included_ids: ids, locked_ids: ids, groups: { type: 'array' }, truncated: { type: 'boolean' } }, required: ['included_ids', 'locked_ids', 'groups', 'truncated'], additionalProperties: false };
export const exportNativeAnonymizedOperations = [
  viewerOperation<Input>({ ...exportMetadata('exports.anonymized.prepare', 'Prepare native anonymized-isolated export membership with explicit source-model seeds, full relationship expansion, locked spatial containers, individual/type exclusions and coupled anonymization controls. Preview only; native source-record behavior intentionally excludes unsaved created entities. truncated means relationship expansion hit its work budget, as the export dialog truncated badge shows.'), effects: ['read'], capability: 'read', outputSchema: previewSchema }, schema, async (i, c) => { const check = nativeExportGuard(c, [i.target_model_id]); check(); const p = await prepare(i, check);
    const preview = { included_ids: [...p.included], locked_ids: [...p.locked], groups: p.related.groups, truncated: p.related.truncated };
    // Groups repeat member ids, so a preview can pass the result limit below the id cap (#10794).
    const bytes = resultBytes(preview);
    if (bytes > MAX_RESULT_BYTES) tooLarge('preview-size', 'The anonymized preview for this selection is larger than the operation result limit.', { bytes, limit: MAX_RESULT_BYTES });
    return preview; }),
  viewerOperation<Input & { expected_included_ids: number[] }>(exportMetadata('exports.anonymized', 'Produce the exact native anonymized IFC subset after rechecking preview membership. Uses the same source-record anonymizer and filename/privacy defaults as the UI. Returns native scrub/pruning warnings; GUID correlation maps stay private and are not exported.'), {
    type: 'object', properties: { ...schema.properties, expected_included_ids: ids }, required: [...schema.required, 'expected_included_ids'], additionalProperties: false,
  } satisfies JSONSchemaType<Input & { expected_included_ids: number[] }>, async (i, c) => {
    const check = nativeExportGuard(c, [i.target_model_id]); check(); const p = await prepare(i, check);
    if (JSON.stringify([...p.included].sort((a, b) => a - b)) !== JSON.stringify([...i.expected_included_ids].sort((a, b) => a - b))) throw new Error('Native anonymized membership changed since preview.');
    const out = produceAnonymizedExport({ store: p.store, fileStem: i.file_stem, includedIds: p.included, options: toAnonymizeOptions(i.anonymize) });
    // Named fields only, so a new stat reaches the agent on purpose. The zeroed placements' original coordinates are
    // what anonymizing removed: the agent gets how many, not where (#10695). truncated: expansion hit its budget (#10794).
    const { entityCount, includedRootEntityCount, prunedRelationshipIds, droppedPropertySetIds, droppedPropertyReferenceIds, warnings, zeroedPlacements } = out.result.stats;
    return nativeArtifact(c, new Blob([new Uint8Array(out.result.content)], { type: 'text/plain' }), out.filename, { entityCount, includedRootEntityCount,
      prunedRelationshipIds, droppedPropertySetIds, droppedPropertyReferenceIds, warnings, zeroedPlacementCount: zeroedPlacements.length, truncated: p.related.truncated }, check);
  }),
];
