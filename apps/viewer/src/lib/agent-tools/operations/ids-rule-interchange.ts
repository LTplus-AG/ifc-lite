/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation } from './contract';
import { assertToolActive } from '../cancellation';
import { invalidInput, stale, parseJsonInput, decodedInput } from './refusals';
const outputSchema = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
export const ruleInterchangeOperations = [
  viewerOperation<{ xml: string; definition_revision: number }>({ id: 'validation.rules.importIds', owner: 'validation', description: 'Convert IDS to native information rules through the exact IDS-to-rules converter, preserving converted/refused/notes diagnostics, then stage the resulting draft. Does not pretend unrepresentable IDS facets converted.', effects: ['configuration'], capability: 'commands-and-edits', implementation: 'native-store', outputSchema }, {
    type: 'object', properties: { xml: { type: 'string', maxLength: 1000000 }, definition_revision: { type: 'integer', minimum: 0 } }, required: ['xml', 'definition_revision'], additionalProperties: false,
  }, async (i, c) => {
    const [{ parseIDS }, { idsToRuleSet }] = await Promise.all([import('@ifc-lite/ids'), import('@ifc-lite/rules')]); const result = idsToRuleSet(decodedInput('xml', () => parseIDS(i.xml))); assertToolActive(c); const file = result.file; if (!file) return { native_json: JSON.stringify(result) };
    return c.commit(() => { const s = useViewerStore.getState(); if (s.validationDefinitionRevision !== i.definition_revision) throw stale('Definitions changed. Inspect again.'); s.setValidationRuleSetDraft(file); return { native_json: JSON.stringify(result) }; });
  }),
  viewerOperation<{ rules_json: string; format: 'json' | 'ids' }>({ id: 'validation.rules.export', owner: 'validation', description: 'Export canonical rules JSON or convert representable rules to IDS using the same native converter and effective-model/unit targets as the panel. Returns explicit refused-rule diagnostics and an artifact only when native conversion produced output.', effects: ['artifact'], capability: 'commands-and-edits', implementation: 'native-store', outputSchema, policy: { artifact: 'native-export' } }, {
    type: 'object', properties: { rules_json: { type: 'string', maxLength: 1000000 }, format: { type: 'string', enum: ['json', 'ids'] } }, required: ['rules_json', 'format'], additionalProperties: false,
  }, async (i, c) => {
    const [{ parseRuleSetFile, serializeRuleSet, ruleSetToIds, resolveTargetModels }, { idsVersionsForSchemas }, { evaluatorModelsFromState }] = await Promise.all([import('@ifc-lite/rules'), import('@/lib/validation/rule-set-ids-browser'), import('@/lib/model-tags/evaluator-models')]);
    const parsed = parseRuleSetFile(parseJsonInput(i.rules_json, 'rules_json')); if (!parsed.ok) throw invalidInput('invalid-value', parsed.error); assertToolActive(c);
    if (i.format === 'json') return { native_json: JSON.stringify({ artifact: await c.artifacts.create({ filename: 'validation.rules.json', mimeType: 'application/json', data: serializeRuleSet(parsed.file) }) }) };
    const s = useViewerStore.getState(), result = ruleSetToIds(parsed.file, { ifcVersions: idsVersionsForSchemas([...s.models.values()].map(model => model.schemaVersion)), models: resolveTargetModels(evaluatorModelsFromState(s), parsed.file.targets) });
    assertToolActive(c); const artifact = result.xml === null ? null : await c.artifacts.create({ filename: 'validation.rules.ids', mimeType: 'application/xml', data: result.xml });
    return { native_json: JSON.stringify({ ...result, artifact }) };
  }),
];
