/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef } from 'react';
import { useViewerStore } from '@/store';
import { getModelById } from '@/lib/llm/models';
import { useAssistantPreferences, projectScope, preferencesFor } from './preferences';

/** The loaded models' project scope and its saved preferences, live. */
export function useProjectPreferences() {
  const models = useViewerStore(s => s.models);
  const entries = useAssistantPreferences(s => s.entries);
  const scope = useMemo(() => projectScope(models.values()), [models]);
  return { scope, preferences: useMemo(() => preferencesFor(scope, entries), [scope, entries]) };
}

/** Applies a project's preferred model once each time that project scope becomes active. */
export function usePreferredModel(): void {
  const { scope, preferences } = useProjectPreferences();
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!scope || !preferences?.model || applied.current === scope.id) return;
    applied.current = scope.id;
    const state = useViewerStore.getState();
    if (getModelById(preferences.model) && state.chatActiveModel !== preferences.model) state.setChatActiveModel(preferences.model);
  }, [scope, preferences]);
}
