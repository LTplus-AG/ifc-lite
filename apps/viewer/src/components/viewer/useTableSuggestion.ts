/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useMemo } from 'react';
import type { CsvRow } from '@ifc-lite/mutations';
import { useAsyncRun } from '@/hooks/useAsyncRun';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import type { TableMapping } from '@/lib/actions/table-mapping';
import { suggestTableMapping, tableMappingContext } from '@/lib/actions/table-mapping-request';

export function useTableSuggestion({ isDraftCurrent, selectedModelId, headers, tableRows, setAiMapping, setError, t }: {
  isDraftCurrent: () => boolean; selectedModelId: string; headers: string[]; tableRows: CsvRow[];
  setAiMapping: (mapping: TableMapping) => void; setError: (message: string | null) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const draft = useMemo(() => ({ isDraftCurrent, selectedModelId, headers, tableRows }),
    [isDraftCurrent, selectedModelId, headers, tableRows]);
  const { busy: suggesting, start } = useAsyncRun({ key: draft, label: 'table suggestion' });
  const handleSuggest = useCallback(() => start(async ({ signal, isCurrent }) => {
    setError(null);
    try {
      const state = useViewerStore.getState();
      const outcome = await suggestTableMapping(tableMappingContext(state, selectedModelId, headers, tableRows),
        state.chatActiveModel, import.meta.env.VITE_LLM_PROXY_URL || '/api/chat', signal);
      if (!isCurrent() || !isDraftCurrent()) return;
      if (outcome.ok) setAiMapping(outcome.mapping);
      else setError(t(`tableChanges.suggestError.${outcome.reason}`, { detail: outcome.detail ?? '' }));
    } catch (error) {
      if (isCurrent() && isDraftCurrent()) setError(error instanceof Error ? error.message : String(error));
    }
  }), [start, isDraftCurrent, selectedModelId, headers, tableRows, setAiMapping, setError, t]);
  return { suggesting, handleSuggest };
}
