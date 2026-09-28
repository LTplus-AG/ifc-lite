/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the Model inspector edits (charter #6232, M2 §1.7, §2.4).
 *
 * Two targets can apply at once: the DEFAULTS of the kind the running
 * command builds (or, with nothing running and nothing selected, the kind
 * built last), and the SELECTED element. With both, a pill switches between
 * them; a running command starts on its defaults, otherwise the selection
 * wins. Outside the Model workspace there is no target.
 *
 * Every write goes through `inspector-edits.ts`: one undo step each.
 */

import { useEffect, useMemo, useState } from 'react';
import { liveEntityConforms } from '@ifc-lite/create';
import { useViewerStore, type ViewerState } from '@/store';
import { fromGlobalIdFromModels } from '@/store/globalId';
import { effectiveListTypeName } from '@/lib/lists/effective-provider-entities';
import { elementStoreyId } from '@/lib/commands/modeling/workplane';
import { authoredKindOf, commandKind, entityName, type LiveModel } from '@/lib/commands/modeling/authored-kinds';
import type { AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';

export type InspectorMode = 'defaults' | 'selection';

export interface InspectorSelection {
  readonly modelId: string;
  readonly expressId: number;
  /** `IfcPascalCase`, retypes included. */
  readonly ifcClass: string;
  /** Null for a class the workspace does not build: only its name is edited here. */
  readonly kind: AuthoredElementKind | null;
  readonly storeyName: string | null;
  readonly live: LiveModel;
}

export interface InspectorTarget {
  readonly inSession: boolean;
  /** The session's model: where defaults (types, layer sets) are picked from. */
  readonly sessionModel: { readonly modelId: string; readonly live: LiveModel } | null;
  readonly defaultsKind: AuthoredElementKind | null;
  readonly selection: InspectorSelection | null;
  readonly mode: InspectorMode | null;
  readonly both: boolean;
  /** In the workspace with no command running and nothing selected: the last kind's defaults show. */
  readonly idle: boolean;
  readonly setMode: (mode: InspectorMode) => void;
}

function liveModel(s: ViewerState, modelId: string): LiveModel | null {
  const dataStore = s.models.get(modelId)?.ifcDataStore;
  return dataStore ? { dataStore, view: s.mutationViews.get(modelId) } : null;
}

function resolveSelection(s: ViewerState): InspectorSelection | null {
  if (s.selectedEntityId === null) return null;
  const ref = s.resolveGlobalIdFromModels(s.selectedEntityId) ?? fromGlobalIdFromModels(s.models, s.selectedEntityId);
  const live = ref ? liveModel(s, ref.modelId) : null;
  if (!ref || !live || !liveEntityConforms(live.dataStore, ref.expressId, 'IfcProduct', live.view)) return null;
  const storeyId = elementStoreyId(s, ref.modelId, ref.expressId);
  return {
    modelId: ref.modelId,
    expressId: ref.expressId,
    ifcClass: effectiveListTypeName(live.dataStore, live.view ?? undefined, ref.expressId),
    kind: authoredKindOf(live, ref.expressId),
    storeyName: storeyId === null ? null : entityName(live, storeyId) || `#${storeyId}`,
    live,
  };
}

export function useInspectorTarget(): InspectorTarget {
  const session = useViewerStore((s) => s.session);
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const lastKind = useViewerStore((s) => s.authoringDefaults.lastKind);
  const setAuthoringDefaults = useViewerStore((s) => s.setAuthoringDefaults);

  const selection = useMemo(() => {
    void selectedEntityId; void models; void mutationVersion; // a rename, retype or deletion
    return session ? resolveSelection(useViewerStore.getState()) : null;
  }, [session, selectedEntityId, models, mutationVersion]);
  const sessionModel = useMemo(() => {
    const live = session ? liveModel(useViewerStore.getState(), session.modelId) : null;
    return session && live ? { modelId: session.modelId, live } : null;
  }, [session, models]);

  const running = commandKind(session?.activeCommandId);
  const defaultsKind = session ? running ?? (selection ? null : lastKind) : null;
  const [picked, setPicked] = useState<InspectorMode | null>(null);
  useEffect(() => setPicked(null), [selectedEntityId, session?.activeCommandId]);
  // "The kind built last": whatever the rail's command builds is next.
  useEffect(() => { if (running && running !== lastKind) setAuthoringDefaults({ lastKind: running }); }, [running, lastKind, setAuthoringDefaults]);

  const both = selection !== null && defaultsKind !== null;
  const mode: InspectorMode | null = both
    ? picked ?? (running ? 'defaults' : 'selection')
    : selection ? 'selection' : defaultsKind ? 'defaults' : null;
  const idle = session !== null && running === null && selection === null;
  return { inSession: session !== null, sessionModel, defaultsKind, selection, mode, both, idle, setMode: setPicked };
}
