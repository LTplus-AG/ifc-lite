/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { viewerOperation, emptySchema } from './contract';
import { assertToolActive } from '../cancellation';
import { internal, invalidInput, stale, unavailable } from './refusals';
const jsonOutput = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
const meta = (id: string, description: string, effect: 'read' | 'configuration' | 'artifact' = 'read') => ({ id, owner: 'validation', description, effects: [effect],
  capability: effect === 'read' ? 'read' as const : 'commands-and-edits' as const, implementation: 'native-store' as const, outputSchema: jsonOutput,
  policy: effect === 'artifact' ? { artifact: 'native-export' as const } : undefined });
function signature() { return JSON.stringify(useViewerStore.getState().manualLibrary); }
function expected(input: string) { if (signature() !== input) throw stale('The native manual checklist or answers changed. Inspect again.'); }
export const manualValidationOperations = [
  viewerOperation(meta('validation.manual.read', 'Read native independent checklists, active template, model-fingerprint answers and persistence diagnostics. A recorded verdict is a supplied observation, not an automated model check.'), emptySchema, () => {
    const s = useViewerStore.getState(); return out({ expected_library: signature(), library: s.manualLibrary, checklist: s.manualChecklist, answers: s.manualAnswers, persistenceError: s.manualSaveError });
  }),
  viewerOperation<{ json: string; expected_library: string }>(meta('validation.manual.import', 'Import/select a canonical native checklist template, retaining its own model-fingerprint answers according to the existing native library contract.', 'configuration'), {
    type: 'object', properties: { json: { type: 'string', maxLength: 1000000 }, expected_library: { type: 'string', maxLength: 1000000 } }, required: ['json', 'expected_library'], additionalProperties: false,
  }, async (i, c) => { const { parseChecklistText } = await import('@/lib/validation/manual/checklist'); const parsed = parseChecklistText(i.json); if (!parsed.ok) throw invalidInput('invalid-value', parsed.error); assertToolActive(c);
    return out(c.commit(() => { expected(i.expected_library); useViewerStore.getState().setManualChecklist(parsed.template); return { expected_library: signature() }; }));
  }),
  viewerOperation<{ action: 'new' | 'close' | 'select' | 'remove' | 'duplicate' | 'rename' | 'group.add' | 'group.rename' | 'group.remove' | 'group.move' | 'item.add' | 'item.update' | 'item.remove' | 'item.move'; id: string; group_id: string; item_id: string; text: string; description: string; delta: number; expected_library: string }>(meta('validation.manual.edit', 'Run exact native checklist/library/group/item editing actions, including ordering. Uses the same store handlers as the Manual-validation controls; never writes an observation implicitly.', 'configuration'), {
    type: 'object', properties: { action: { type: 'string', enum: ['new', 'close', 'select', 'remove', 'duplicate', 'rename', 'group.add', 'group.rename', 'group.remove', 'group.move', 'item.add', 'item.update', 'item.remove', 'item.move'] }, id: { type: 'string', maxLength: 200 }, group_id: { type: 'string', maxLength: 200 }, item_id: { type: 'string', maxLength: 200 }, text: { type: 'string', maxLength: 500 }, description: { type: 'string', maxLength: 2000 }, delta: { type: 'integer', minimum: -1, maximum: 1 }, expected_library: { type: 'string', maxLength: 1000000 } },
    required: ['action', 'id', 'group_id', 'item_id', 'text', 'description', 'delta', 'expected_library'], additionalProperties: false,
  }, (i, c) => out(c.commit(() => {
    const s = useViewerStore.getState();
    if (['select', 'remove', 'duplicate'].includes(i.action) && !s.manualLibrary.checklists.some(row => row.id === i.id)) throw invalidInput('unknown-target', 'Unknown checklist instance.');
    if (i.action.startsWith('group.') && i.action !== 'group.add' && !s.manualChecklist?.groups.some(row => row.id === i.group_id)) throw invalidInput('unknown-target', 'Unknown checklist group.');
    if (i.action.startsWith('item.') && !s.manualChecklist?.groups.some(row => row.id === i.group_id && (i.action === 'item.add' || row.items.some(item => item.id === i.item_id)))) throw invalidInput('unknown-target', 'Unknown checklist group/item.');
    expected(i.expected_library);
    switch (i.action) {
      case 'new': s.newManualChecklist(); break; case 'close': s.setManualChecklist(null); break;
      case 'select': s.selectManualChecklist(i.id); break; case 'remove': s.removeManualChecklist(i.id); break;
      case 'duplicate': s.duplicateManualChecklist(i.id, i.text || undefined); break; case 'rename': s.renameManualChecklist(i.text); break;
      case 'group.add': s.addManualGroup(i.text); break; case 'group.rename': s.renameManualGroup(i.group_id, i.text); break;
      case 'group.remove': s.removeManualGroup(i.group_id); break; case 'group.move': s.moveManualGroup(i.group_id, i.delta); break;
      case 'item.add': s.addManualItem(i.group_id, i.text); break; case 'item.update': s.updateManualItem(i.group_id, i.item_id, { text: i.text, description: i.description }); break;
      case 'item.remove': s.removeManualItem(i.group_id, i.item_id); break; case 'item.move': s.moveManualItem(i.group_id, i.item_id, i.delta); break;
    }
    return { expected_library: signature(), persistenceError: useViewerStore.getState().manualSaveError };
  }))),
  viewerOperation<{ fingerprint: string; item_id: string; status: 'pass' | 'fail' | 'warning' | 'unanswered'; comment: string; expected_library: string }>(meta('validation.manual.answer', 'Record a supplied verdict/comment against an exact durable model fingerprint and checklist item. This does not establish that a physical/manual check was performed.', 'configuration'), {
    type: 'object', properties: { fingerprint: { type: 'string', minLength: 1, maxLength: 200 }, item_id: { type: 'string', minLength: 1, maxLength: 200 }, status: { type: 'string', enum: ['pass', 'fail', 'warning', 'unanswered'] }, comment: { type: 'string', maxLength: 2000 }, expected_library: { type: 'string', maxLength: 1000000 } }, required: ['fingerprint', 'item_id', 'status', 'comment', 'expected_library'], additionalProperties: false,
  }, (i, c) => out(c.commit(() => { const s = useViewerStore.getState();
    if (!s.manualChecklist?.groups.some(group => group.items.some(item => item.id === i.item_id))) throw invalidInput('unknown-target', 'Unknown checklist item.');
    expected(i.expected_library);
    return s.setManualAnswer(i.fingerprint, i.item_id, { status: i.status === 'unanswered' ? null : i.status, comment: i.comment });
  }))),
  viewerOperation({ ...meta('validation.manual.export', 'Export the active native checklist template as a host-owned JSON artifact.', 'artifact'), outputSchema: {
    type: 'object', properties: { artifact_id: { type: 'string' }, filename: { type: 'string' }, mime_type: { type: 'string' }, bytes: { type: 'integer' } }, required: ['artifact_id', 'filename', 'mime_type', 'bytes'], additionalProperties: false,
  } }, emptySchema, async (_, c) => { const { serializeChecklist } = await import('@/lib/validation/manual/checklist'); const template = useViewerStore.getState().manualChecklist; if (!template) throw unavailable('No manual checklist is open.'); assertToolActive(c);
    return c.artifacts.create({ filename: 'manual.checklist.json', mimeType: 'application/json', data: serializeChecklist(template) });
  }),
  viewerOperation<{ name: string; fingerprint: string; expected_library: string }>(meta('validation.manual.saveReport', 'Snapshot the explicit current checklist and supplied model-fingerprint answers into the native durable report library. An empty fingerprint creates an unbound report; no verdict is invented.', 'configuration'), {
    type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, fingerprint: { type: 'string', maxLength: 200 }, expected_library: { type: 'string', maxLength: 1000000 } }, required: ['name', 'fingerprint', 'expected_library'], additionalProperties: false,
  }, async (i, c) => {
    const [{ manualReportBlockFromChecklist }, { reportModelScope }] = await Promise.all([import('@/lib/document/manual-report'), import('@/lib/document/report-provenance')]); assertToolActive(c); expected(i.expected_library);
    const s = useViewerStore.getState(); if (!s.manualChecklist) throw unavailable('No manual checklist is open.');
    const model = [...s.models.values()].find(row => row.sourceFingerprint === i.fingerprint);
    const block = manualReportBlockFromChecklist({ checklist: s.manualChecklist, answers: i.fingerprint ? s.manualAnswers[i.fingerprint] ?? {} : {},
      ...(i.fingerprint ? { modelFingerprint: i.fingerprint, modelName: model?.name } : {}) }, 'run');
    const scope = model ? reportModelScope(model.name, model.id, i.fingerprint) : null;
    const snapshot = { ...block, reportModels: scope ? [scope] : [] };
    const id = await c.commitAsync(() => { expected(i.expected_library); return useViewerStore.getState().saveValidationReport(snapshot, i.name); }, saved => !!saved);
    if (!id) throw internal('Native report persistence failed.'); return out({ id });
  }),
];
