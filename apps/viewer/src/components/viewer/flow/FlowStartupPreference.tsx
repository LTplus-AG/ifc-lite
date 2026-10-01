/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { readStartupFlowId, saveStartupFlowId } from '@/lib/flow/startup-preference';

export function FlowStartupPreference() {
  const { t } = useTranslation();
  const activeFlowId = useViewerStore((s) => s.activeFlowId);
  const savedFlows = useViewerStore((s) => s.savedFlows);
  const [startupId, setStartupId] = useState(readStartupFlowId);
  const [error, setError] = useState<string | null>(null);
  if (!activeFlowId || !savedFlows.some((flow) => flow.doc.id === activeFlowId)) return null;
  return <div>
    <label className="flex items-center gap-1">
      <input type="checkbox" checked={startupId === activeFlowId} onChange={(event) => {
        const next = event.target.checked ? activeFlowId : null;
        try { saveStartupFlowId(next); setStartupId(next); setError(null); }
        catch (cause) { setError(t('flowStartup.storageError', { reason: cause instanceof Error ? cause.message : String(cause) })); }
      }} />
      {t('flowStartup.optIn')}
    </label>
    {error && <output className="text-destructive">{error}</output>}
  </div>;
}
