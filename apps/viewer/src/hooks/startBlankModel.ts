/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical welcome/palette blank-model action (#8947, #6232). */
import { useViewerStore, type ViewerState } from '@/store';
import { selectHasModelsLoaded } from './model-presence';
import { getWebGPUStatus } from './useWebGPU';
import type { useIfcLoader } from './useIfcLoader';
import type { TranslationKey } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { createBlankIfcFile } from '@/utils/createBlankIfc';
import { launchModelCommand } from '@/lib/commands/modeling/keys-workspace';

export function blankModelUnavailable(s: ViewerState = useViewerStore.getState()): TranslationKey | null {
  if (!s.canCollabEdit()) return 'commandPalette.availability.editor';
  if (s.loading) return 'commandPalette.availability.loading';
  if (selectHasModelsLoaded(s) || s.models.size > 0 || s.session !== null) return 'commandPalette.availability.blankSession';
  const gpu = getWebGPUStatus();
  if (gpu.checking) return 'commandPalette.availability.gpuChecking';
  return gpu.supported ? null : 'commandPalette.availability.gpu';
}

export async function startBlankModel(loadFile: ReturnType<typeof useIfcLoader>['loadFile'],
  isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) throw new Error(resolve('commandPalette.availability.host'));
  const reason = blankModelUnavailable();
  if (reason) throw new Error(resolve(reason));
  const file = createBlankIfcFile();
  const modelId = crypto.randomUUID();
  // loadFile resets the workspace: enter only after this exact target completes.
  await loadFile(file, { kind: 'primary', modelId });
  const state = useViewerStore.getState();
  if (!isCurrent() || state.loading || !state.canCollabEdit()
    || state.activeModelId !== modelId || state.models.get(modelId)?.loadState !== 'complete') return;
  if (state.enterModelWorkspace({ modelId })) launchModelCommand('wall.place');
}
