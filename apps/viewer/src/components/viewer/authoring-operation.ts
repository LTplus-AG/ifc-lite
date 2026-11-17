/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useLayoutEffect, useMemo } from 'react';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';

/** A draft survives closing; an operation belongs to one open target lifetime. */
export function useAuthoringOperation(open: boolean, modelId: string,
  data: IfcDataStore | null | undefined, view: MutablePropertyView | undefined) {
  const token = useMemo(() => ({ active: false }), [open, modelId, data, view]);
  useLayoutEffect(() => { token.active = open; return () => { token.active = false; }; }, [token, open]);
  return useMemo(() => () => {
    const state = useViewerStore.getState();
    const liveData = modelId === '__legacy__' ? state.ifcDataStore : state.models.get(modelId)?.ifcDataStore;
    return token.active && liveData === data && (state.getMutationView(modelId) ?? undefined) === view;
  }, [token, modelId, data, view]);
}

/** A committed dialog/source lease; model validity belongs to the operation's actual participants. */
export function useDialogOperation(open: boolean, context: string) {
  const token = useMemo(() => ({ active: false }), [open, context]);
  useLayoutEffect(() => { token.active = open; return () => { token.active = false; }; }, [token, open]);
  return useMemo(() => () => token.active, [token]);
}
