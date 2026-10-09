/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "What was sent" for one IDS-agent run (IDS-086, FR-F08): every piece of
 * every request, exactly as it left the browser, from `privacyView`. Closed
 * by default; each entry expands to its full text.
 */

import { privacyView, type AgentRun } from '@ifc-lite/ids-agent';
import { useTranslation } from '@/i18n';

export function IdsAgentPrivacy({ run }: { run: AgentRun }) {
  const { t } = useTranslation();
  const view = privacyView(run);
  return <details className="rounded border border-border/70 p-1.5">
    <summary className="cursor-pointer font-medium">{t('idsAgent.sent')}</summary>
    <div className="mt-1 space-y-1.5">
      <p className="text-muted-foreground">{t('idsAgent.sentIntro', { model: run.proposal.model })}</p>
      <p>{t(view.modelDataSent ? 'idsAgent.sentModelData' : 'idsAgent.sentNoModelData')}</p>
      <ol className="space-y-1">
        {view.requests.map(request => <li key={request.index} className="space-y-0.5">
          <p className="text-2xs text-muted-foreground">{t('idsAgent.sentRequest', { index: request.index + 1, resent: request.resentMessages })}</p>
          <ul className="pl-2 space-y-0.5">
            {request.entries.map((entry, index) => <li key={index}>
              <details>
                <summary className="cursor-pointer break-words">{t('idsAgent.sentEntry', { label: entry.label, chars: entry.chars })}</summary>
                <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-1 text-2xs">{entry.text}</pre>
              </details>
            </li>)}
          </ul>
        </li>)}
      </ol>
      <p className="text-2xs text-muted-foreground break-all">{t('idsAgent.sentDigest', { digest: view.payloadDigest })}</p>
    </div>
  </details>;
}
