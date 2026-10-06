/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import type { FlowCodeParam } from '@/lib/assistant/flow-validate';

/** Model-written script source, shown verbatim and expanded: it runs on the next Run (#6919). */
export function FlowCodeParams({ code }: { code: readonly FlowCodeParam[] }) {
  const { t } = useTranslation();
  if (!code.length) return null;
  return <div role="group" aria-label={t('flowAssistant.codeTitle')} className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1">
    <p className="font-semibold">{t('flowAssistant.codeTitle')}</p>
    <p className="text-muted-foreground">{t('flowAssistant.codeHint')}</p>
    {code.map(entry => <div key={`${entry.nodeId}:${entry.param}`} className="space-y-0.5">
      <p className="font-mono break-words">{t('flowAssistant.codeParam', { node: entry.nodeId, param: entry.param, language: entry.language ?? t('assistant.none') })}</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{entry.code}</pre>
    </div>)}
  </div>;
}
