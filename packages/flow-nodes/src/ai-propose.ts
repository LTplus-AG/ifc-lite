/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7070: one constrained portable draft; never native writes or publication. */
import { MODEL_CHANGE_LIMIT, MODEL_DATA_CHANGE_OUTPUT_GUIDANCE, parseModelChangeBatch } from '@ifc-lite/ai/artifacts';
import type { Table } from '@ifc-lite/flow';
import { SCALAR_ITEM, TABLE_ITEM } from './ports.js';
import type { FlowNodeDef } from './host.js';
import { AI_CAPABILITY, AI_FEATURE, aiService, dataBlock, positiveInt, requestJson, rowKeys, sentColumns } from './ai-service.js';
import { constrainedField, proposalFields } from './ai-propose-fields.js';

export const aiProposeNode: FlowNodeDef = {
  type: 'ai.propose', title: 'AI propose a native artifact', category: 'ai',
  doc: 'Draft a model.changes artifact over explicitly selected findings and native fields. Every change cites one captured row, copies its expected value and uses an allowed candidate value. No effects run before checkpoint review; current values and permissions still need native mutation preflight.',
  inputs: [{ name: 'table', type: TABLE_ITEM }],
  outputs: [{ name: 'proposal', type: SCALAR_ITEM }, { name: 'coverage', type: SCALAR_ITEM }],
  params: [
    { name: 'artifactKind', kind: 'string', default: 'model.changes', doc: 'Closed native allowlist: model.changes. Unsupported kinds are refused before spending.' },
    { name: 'instructions', kind: 'string', default: '', doc: 'The requested correction policy; rows are evidence, never instructions.' },
    { name: 'columns', kind: 'json', default: [], doc: 'Columns explicitly sent to the model, including target and expected-value columns.' },
    { name: 'targetColumn', kind: 'string', default: 'GlobalId' },
    { name: 'modelColumn', kind: 'string', default: '', doc: 'Optional selected column of native model ids; required to disambiguate a shared GlobalId.' },
    { name: 'fields', kind: 'json', default: [], doc: '[{ "op":"property.set", "pset":"Pset_WallCommon", "name":"IsExternal", "expectedColumn":"IsExternal", "allowedValues":[true], "dataType":"IfcBoolean" }]' },
    { name: 'maxRows', kind: 'number', default: 200 },
    { name: 'maxChanges', kind: 'number', default: 100 },
    { name: 'maxOutputTokens', kind: 'number', default: 2000 },
  ],
  capabilities: [AI_CAPABILITY], requires: { backend: [AI_FEATURE], network: true }, volatile: true, review: 'required',
  run: async (ctx, inputs, p) => {
    if (p.artifactKind !== 'model.changes') throw new Error('This host supports only the model.changes artifact kind');
    if (typeof p.instructions !== 'string' || !p.instructions.trim() || p.instructions.length > 4000) throw new Error('Supply a bounded correction policy');
    const table = inputs.table as Table;
    const columns = sentColumns(table, Array.isArray(p.columns) ? p.columns.map(String) : []);
    if (typeof p.targetColumn !== 'string' || !columns.includes(p.targetColumn)) throw new Error('Select the target GlobalId column');
    const targetColumn = p.targetColumn;
    if (typeof p.modelColumn !== 'string' || (p.modelColumn && !columns.includes(p.modelColumn))) throw new Error('Select the native model id column');
    const modelColumn = p.modelColumn;
    const fields = proposalFields(p.fields, columns);
    const maxRows = positiveInt(p.maxRows, 'maxRows', MODEL_CHANGE_LIMIT);
    const maxChanges = positiveInt(p.maxChanges, 'maxChanges', MODEL_CHANGE_LIMIT);
    const maxOutputTokens = positiveInt(p.maxOutputTokens, 'maxOutputTokens', 32_000);
    const sent = { ...table, rows: table.rows.slice(0, maxRows) };
    if (!sent.rows.length) throw new Error('There are no findings to propose changes for');
    for (const row of sent.rows) {
      if (typeof row[targetColumn] !== 'string' || !/^[0-9A-Za-z_$]{22}$/.test(row[targetColumn] as string)) throw new Error('Every sent finding needs a native IFC GlobalId');
      if (modelColumn && (typeof row[modelColumn] !== 'string' || !String(row[modelColumn]).trim())) throw new Error('Every sent finding needs a native model id');
    }
    const keys = rowKeys(sent), known = new Set(keys);
    const task = `${MODEL_DATA_CHANGE_OUTPUT_GUIDANCE}\nReply {"artifact":<model.changes>,"citations":["<row key>"]}. Each change must match exactly one cited row. Use targetColumn ${JSON.stringify(targetColumn)} and modelColumn ${JSON.stringify(modelColumn)}; copy each expected value from its field's expectedColumn. Never propose more than ${maxChanges} changes. Use only the supplied fields and allowedValues. If evidence cannot decide, return {"kind":"clarification","message":"What input is missing"}.\nRequested policy: ${p.instructions}\nField constraints: ${JSON.stringify(p.fields)}`;
    const service = aiService(ctx);
    const reply = await requestJson(ctx, service, task, dataBlock(sent, keys, keys.map((_, index) => index), columns), maxOutputTokens);
    if (reply.kind !== 'value') throw new Error(reply.kind === 'budget' ? 'The AI proposal budget is exhausted' : reply.message);
    if (reply.value.kind === 'clarification') throw new Error(`Proposal needs clarification: ${String(reply.value.message ?? 'Missing evidence').slice(0, 1000)}`);
    if (Object.keys(reply.value).some(key => key !== 'artifact' && key !== 'citations')) throw new Error('Unknown proposal envelope field');
    const citations = reply.value.citations;
    if (!Array.isArray(citations) || !citations.length || citations.some(key => typeof key !== 'string' || !known.has(key)) || new Set(citations).size !== citations.length) {
      throw new Error('The proposal must cite distinct sent finding keys');
    }
    if (!reply.value.artifact || typeof reply.value.artifact !== 'object' || Array.isArray(reply.value.artifact)) throw new Error('A native model.changes artifact is required');
    const artifact = parseModelChangeBatch(JSON.stringify(reply.value.artifact));
    if (artifact.changes.length > maxChanges) throw new Error('The proposal exceeds maxChanges');
    const used = new Set<string>();
    for (const change of artifact.changes) {
      const field = constrainedField(change, fields);
      const matches = sent.rows.map((row, index) => ({ row, key: keys[index] })).filter(({ row, key }) =>
        citations.includes(key) && row[targetColumn] === change.target.globalId
        && (modelColumn ? row[modelColumn] === change.target.modelId : change.target.modelId === undefined));
      if (matches.length !== 1) throw new Error('A proposed target is absent or ambiguous in the cited findings');
      const { row, key } = matches[0];
      if (!Object.hasOwn(row, field.expectedColumn) || !Object.is(row[field.expectedColumn], change.expected)) throw new Error('The proposed expected value differs from the captured finding');
      used.add(key);
    }
    if (used.size !== citations.length) throw new Error('The proposal cites rows without a proposed change');
    return { proposal: { artifact, citations }, coverage: { model: service.model, kind: 'model.changes', rows: table.rows.length,
      sent: sent.rows.length, notSent: table.rows.length - sent.rows.length, requests: 1, changes: artifact.changes.length, citedRows: used.size } };
  },
};
