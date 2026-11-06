/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Read-only checks over the same copy and transform planners as the tools (#8947). */
import { createCopyContext, copySourcesInStore, productStoreyOrigin } from '@ifc-lite/create';
import type { TranslationKey } from '@/i18n';
import type { ViewerState } from '@/store';
import { readModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { readTransformSelection } from '@/lib/commands/modeling/commands/element-transform-shared';
import { selectedElements, readCopyClipboard } from '@/lib/commands/modeling/copy-clipboard';
import { modelStoreys, sessionWorkplaneBlock } from '@/lib/commands/modeling/workspace-storeys';
import { modelWorkspaceTarget } from '@/lib/commands/modeling/workspace-target';
import { resolveWorkplane } from '@/lib/commands/modeling/registry';
import { elementStoreyId } from '@/lib/commands/modeling/workplane';

export const modelEditIds = new Set(['tool:array', 'tool:move', 'tool:rotate', 'model:copy',
  'model:paste', 'model:paste-in-place', 'model:storey-up', 'model:storey-down', 'model:exit']);

export function paletteModelBlock(id: string, s: ViewerState): TranslationKey | null {
  if (!modelEditIds.has(id)) return null;
  const inWorkspace = s.workspaceMode === 'model' && s.session !== null;
  if (id === 'model:exit') return inWorkspace ? null : 'commandPalette.availability.workspace';
  if (!s.canCollabEdit()) return 'commandPalette.availability.editor';
  if (s.loading) return 'commandPalette.availability.loading';
  if (id === 'model:copy' || id.startsWith('model:storey-')) {
    if (!inWorkspace) return 'commandPalette.availability.workspace';
  }
  const target = s.session ?? modelWorkspaceTarget(s);
  if (!target) return 'commandPalette.availability.ifc';
  if (id.startsWith('model:storey-')) {
    const storeys = modelStoreys(s, target.modelId);
    const at = storeys.findIndex(row => row.expressId === target.storeyId);
    return at >= 0 && storeys[at + (id.endsWith('up') ? 1 : -1)] ? null : 'commandPalette.availability.storeyBoundary';
  }
  if (id !== 'model:copy') {
    const noPlane = s.session ? sessionWorkplaneBlock(s) : target.storeyId === null
      || 'refused' in resolveWorkplane(s, target.modelId, { kind: 'storey', storeyId: target.storeyId, offset: 0 });
    if (noPlane) return 'commandPalette.availability.workplane';
  }
  const paste = id === 'model:paste' || id === 'model:paste-in-place';
  const clip = paste ? readCopyClipboard() : null;
  if (paste && !clip) return 'copyArray.paste.empty';
  if (id === 'tool:move' || id === 'tool:rotate') {
    const selection = readTransformSelection(s);
    if (!selection) return 'moveRotate.noSelection';
    if (selection.modelId !== target.modelId) return 'commandPalette.availability.selection';
    return selection.refusal ? 'moveRotate.refused' : null;
  }
  const selected = paste ? clip : selectedElements(s);
  if (!selected || selected.ids.length === 0) return 'commandPalette.availability.selection';
  if (selected.modelId !== target.modelId) return paste ? 'copyArray.paste.otherModel' : 'commandPalette.availability.selection';
  const readTarget = readModelEditTarget(s, selected.modelId);
  if (!readTarget) return 'commandPalette.availability.ifc';
  const { dataStore, editor } = readTarget;
  const context = createCopyContext(dataStore, editor);
  const sources = copySourcesInStore(context, selected.ids);
  if ('refusal' in sources) return paste ? 'copyArray.paste.stale' : 'commandPalette.availability.copyTarget';
  if (id === 'tool:array') {
    const storeyId = elementStoreyId(s, selected.modelId, sources.ids[0]);
    if (storeyId === null || 'refused' in resolveWorkplane(s, selected.modelId, { kind: 'storey', storeyId, offset: 0 })) {
      return 'commandPalette.availability.workplane';
    }
  }
  if (id === 'model:copy') {
    if (globalThis.getSelection?.()?.toString()) return 'commandPalette.availability.textSelection';
    try {
      if (!productStoreyOrigin(context, sources.ids[0])) return 'commandPalette.availability.copyTarget';
    } catch (error) {
      console.debug('[CommandPalette] Copy placement refused', error);
      return 'commandPalette.availability.copyTarget';
    }
  }
  return null;
}
