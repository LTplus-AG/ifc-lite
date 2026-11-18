/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { evaluateNativeLens, applyNativeLensResult, clearLensOutput, syncNativeLensHidden } from '@/lib/lens/native-lens';
import { releaseNativeLensRuleIsolation, switchNativeLens } from '@/lib/lens/native-controls';
import { operation, viewerOperation, emptySchema } from './contract';
import { metadata, idSchema, jsonSchema, removedSchema, checkpoint } from './analytics-common';
function inspect() {
  const s = useViewerStore.getState();
  return { lenses: s.savedLenses, activeId: s.activeLensId, matched: s.lensColorMap.size,
    hiddenIds: [...s.lensHiddenIds], rule_members: [...s.lensRuleEntityIds], counts: [...s.lensRuleCounts], legend: s.lensAutoColorLegend };
}
const output = { type: 'object', properties: { lenses: { type: 'array' }, activeId: { type: ['string', 'null'] }, matched: { type: 'integer' }, hiddenIds: { type: 'array', items: { type: 'integer' } }, counts: { type: 'array' }, rule_members: { type: 'array' }, legend: { type: 'array' } }, required: ['lenses', 'activeId', 'matched', 'hiddenIds', 'counts', 'rule_members', 'legend'], additionalProperties: false };
export const analyticsLensOperations = [
  viewerOperation(metadata('lens.state', 'lens', 'Read saved rule/auto-color definitions and effective matched/hidden output.', ['read'], output), emptySchema, inspect),
  viewerOperation<{ content_json: string }>(metadata('lens.import', 'lens', 'Import/upsert native lens JSON array, including Rules filters, actions and auto-color settings; uses native validation and explicit save outcomes.', ['configuration'], output), jsonSchema, (i, c) => {
    const parsed: unknown = JSON.parse(i.content_json);
    if (!Array.isArray(parsed) || parsed.length > 100) throw new Error('Expected an array of at most 100 native lenses.');
    checkpoint(c); const result = c.commit(() => useViewerStore.getState().importLenses(parsed));
    if (!result.ok) throw new Error(result.message); return inspect();
  }),
  operation<{ id: string }>(metadata('lens.apply', 'lens', 'Await the shared native rule evaluator, then apply exact renderer color/visibility output. Works with the Lens panel closed; refuses cancellation before committing.', ['read', 'configuration', 'view'], output), idSchema, async (i, c) => {
    const before = useViewerStore.getState();
    const lens = before.savedLenses.find(row => row.id === i.id);
    if (!lens) throw new Error('Unknown lens.');
    const snapshot = structuredClone(lens);
    const result = await evaluateNativeLens(snapshot, c.signal);
    checkpoint(c);
    const now = useViewerStore.getState();
    if (now.models !== before.models || now.ifcDataStore !== before.ifcDataStore || now.mutationVersion !== before.mutationVersion
      || now.savedLenses !== before.savedLenses || now.modelTags !== before.modelTags || now.modelTagAssignments !== before.modelTagAssignments
      || now.activeLensId !== before.activeLensId) throw new Error('Lens inputs or active lens changed during evaluation.');
    c.commit(() => { switchNativeLens(i.id); if (!applyNativeLensResult(snapshot, result)) throw new Error('Lens evaluation inputs changed before publication.'); syncNativeLensHidden(); }); return inspect();
  }),
  viewerOperation(metadata('lens.clear', 'lens', 'Deactivate the lens and release only its owned color/hide/isolation state.', ['configuration', 'view'], output), emptySchema, (_, c) => {
    checkpoint(c); c.commit(() => {
      useViewerStore.getState().setActiveLens(null); clearLensOutput(); syncNativeLensHidden();
      releaseNativeLensRuleIsolation();
    }); return inspect();
  }),
  viewerOperation<{ id: string }>(metadata('lens.delete', 'lens', 'Delete a saved native lens with explicit persistence-failure reporting.', ['configuration', 'view'], removedSchema), idSchema, (i, c) => {
    const lens = useViewerStore.getState().savedLenses.find(row => row.id === i.id);
    if (!lens) throw new Error('Unknown lens.');
    if (lens.builtin) throw new Error('Built-in lenses cannot be deleted.');
    checkpoint(c);
    const result = c.commit(() => {
      const state = useViewerStore.getState();
      const deleted = state.deleteLens(i.id);
      if (deleted.ok && state.activeLensId === i.id) {
        releaseNativeLensRuleIsolation();
        clearLensOutput();
        syncNativeLensHidden();
      }
      return deleted;
    });
    if (!result.ok) throw new Error(result.message); return { removed: i.id };
  }),
];
