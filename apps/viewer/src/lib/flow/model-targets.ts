/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isModelSelector, type ModelSelector, type SessionModels } from '@ifc-lite/flow-nodes';
import { normalizeModelTagName } from '@ifc-lite/rules';
import type { ViewerState } from '@/store';

export function resolveModels(selector: ModelSelector, state: ViewerState, session?: SessionModels): string[] {
  if (!isModelSelector(selector)) throw new Error('Invalid model selector');
  const allowed = session ? new Set(session.models.map((m) => m.modelId)) : new Set(state.models.keys());
  const slotIds = selector.kind === 'slot' && session ? [...new Set(session.models.map((m) => m.slotId))].filter((id) => id === selector.slotId || (!selector.slotId.includes('/') && id.endsWith(`/${selector.slotId}`))) : [];
  if (slotIds.length > 1) throw new Error(`Ambiguous model slot ${selector.kind === 'slot' ? selector.slotId : ''}; use its qualified address`);
  const candidates = session
    ? [...new Set(session.models.map((model) => model.modelId))].flatMap((id) => { const model = state.models.get(id); return model ? [model] : []; })
    : [...state.models.values()];
  const found = candidates.filter((m) => {
    if (!allowed.has(m.id)) return false;
    if (selector.kind === 'slot') return session?.models.some((s) => s.modelId === m.id && slotIds.includes(s.slotId));
    if (selector.kind === 'filename') return (session?.models.find((s) => s.modelId === m.id)?.filename ?? m.sourceFile?.name ?? m.name) === selector.filename;
    const name = normalizeModelTagName(selector.tagName);
    return [...state.modelTagAssignments.get(m.id) ?? []].some((id) => normalizeModelTagName(state.modelTags.get(id)?.name ?? '') === name);
  });
  if (found.length === 0) throw new Error(`No model matches ${JSON.stringify(selector)}`);
  if (selector.kind === 'filename' && found.length > 1) throw new Error(`Duplicate source filename ${selector.filename}; use a named slot`);
  return found.map((m) => m.id);
}
export function resolveOneModel(selector: ModelSelector, state: ViewerState, session: SessionModels): string {
  const ids = resolveModels(selector, state, session);
  if (ids.length !== 1) throw new Error(`Comparison role must match exactly one model: ${JSON.stringify(selector)}`);
  return ids[0];
}
