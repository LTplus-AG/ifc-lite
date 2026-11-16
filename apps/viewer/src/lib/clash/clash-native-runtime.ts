/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { cancelClashRun, clearClashRun } from '@/hooks/analysisRunCancellation';
import { useViewerStore } from '@/store';
import { releaseOwnedClashVisibility } from '@/lib/clash/visibility-ownership';
import { createClashDetection } from './clash-native-detection';
import { createClashFocus } from './clash-native-focus';
import { createClashExport } from './clash-native-export';
export interface ClashRunRefs {
  runEpochRef: { current: number };
  runAbortRef: { current: AbortController | null };
}
export function createNativeClashRuntime(
  { runEpochRef, runAbortRef }: ClashRunRefs,
  options: Parameters<typeof createClashExport>[0] & { publish?: (write: () => boolean) => boolean } = {},
) {
  const clear = useViewerStore.getState().clearClash;
  const installClashIsolation = (ids: Set<number>): void => {
    useViewerStore.setState({
      isolatedEntities: ids,
      ghostExceptEntities: null,
      hiddenEntities: new Set<number>(),
      idsFocusVisibilityOwned: null,
      basketVisibilityOwned: null,
      chartVisibilityOwned: null,
      listVisibilityOwned: null,
      clashVisibilityOwned: { channel: 'isolate', ids },
    });
  };
  const installClashGhost = (ids: Set<number>): void => {
    useViewerStore.setState({
      isolatedEntities: null,
      ghostExceptEntities: ids,
      idsFocusVisibilityOwned: null,
      basketVisibilityOwned: null,
      chartVisibilityOwned: null,
      listVisibilityOwned: null,
      clashVisibilityOwned: { channel: 'ghost', ids },
    });
  };
  const releaseClashVisibility = (): void => {
    releaseOwnedClashVisibility(useViewerStore.getState());
  };
  const discardSolidPresentation = (): void => {
    const state = useViewerStore.getState();
    releaseClashVisibility();
    state.clearClashFocus();
    state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
  };
  const clearAll = (): void => {
    clearClashRun(runEpochRef, runAbortRef);
    const state = useViewerStore.getState();
    state.clearEntitySelection();
    state.clearIsolation();
    state.clearGhost();
    state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
    clear();
  };
  const invalidateSolidCompute = (): void => {
    useViewerStore.setState((s) => ({ clashSolidRequestSeq: s.clashSolidRequestSeq + 1 }));
  };
  const detection = createClashDetection({
    runEpochRef,
    runAbortRef,
    discardSolidPresentation,
    publish: options.publish,
  });
  const focus = createClashFocus({ installClashIsolation, installClashGhost });
  return {
    ...detection,
    ...focus,
    ...createClashExport(options),
    clearAll,
    invalidateSolidCompute,
    cancelRun: () => cancelClashRun(runEpochRef, runAbortRef),
  };
}
