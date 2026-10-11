/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Inline diagnostics for the node the inspector shows (IDS-036). */

import type { Uuid } from '@ifc-lite/ids-authoring';
import { useTranslation } from '@/i18n';
import { sortDiagnostics } from '@/lib/ids-studio/diagnostics';
import { DiagnosticItem } from './DiagnosticItem';
import { useDiagnosticsContext } from './useStudio';

export function NodeDiagnostics({ nodeId }: { nodeId: Uuid }) {
  const { t } = useTranslation();
  const { byRow } = useDiagnosticsContext();
  const list = byRow.get(nodeId);
  if (!list?.length) return null;
  return <section aria-label={t('idsStudio.diagnostics.forNode')} className="space-y-1">
    <h4 className="text-2xs font-semibold text-muted-foreground">{t('idsStudio.diagnostics.forNode')}</h4>
    <ul className="space-y-1">{sortDiagnostics(list).map((d) => <DiagnosticItem key={`${d.code}|${d.nodeId}|${d.field ?? ''}`} diagnostic={d} />)}</ul>
  </section>;
}
