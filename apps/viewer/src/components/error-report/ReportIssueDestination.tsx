/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import type { IssueResolution, ReportCorrelation, VerifiedIssueTarget } from '@ifc-lite/report-contract';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { ReportClient, safeIssueUrl } from '@/services/error-reports/client';
export interface IssueChoice { reviewed: boolean; target?: VerifiedIssueTarget }
export function ReportIssueDestination({ correlation, enabled, client, value, onChange }: {
  correlation?: ReportCorrelation; enabled: boolean; client: ReportClient;
  value: IssueChoice; onChange: (value: IssueChoice) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'checking' | IssueResolution['status']>('idle');
  const [target, setTarget] = useState<VerifiedIssueTarget>();
  async function check() {
    if (!correlation) return;
    setState('checking'); onChange({ reviewed: false }); setTarget(undefined);
    try {
      const result = await client.request<IssueResolution>('/resolve-issue', 'POST', correlation);
      if (result.status === 'matched' && result.target && safeIssueUrl(result.target.issueUrl)) {
        setTarget(result.target); setState('matched');
      } else setState(result.status === 'unmatched' ? 'unmatched' : 'unavailable');
    } catch { setState('unavailable'); }
  }
  return <div className="space-y-2 rounded border p-3">
    <p>{t('errorReport.destination')}</p>
    {!correlation || !enabled ? <p>{t('errorReport.noCorrelation')}</p> : <>
      <p>{t('errorReport.correlationPrivate')}</p>
      <Button variant="outline" disabled={state === 'checking'} onClick={() => { void check(); }}>{t(state === 'checking' ? 'errorReport.checkingIssue' : 'errorReport.checkIssue')}</Button>
      {state === 'unmatched' && <p>{t('errorReport.issueUnmatched')}</p>}
      {state === 'unavailable' && <p role="alert">{t('errorReport.issueUnavailable')}</p>}
      {target && <label className="block"><input type="radio" name="issue-destination" checked={value.target?.issueUrl === target.issueUrl} onChange={() => onChange({ reviewed: true, target })} /> {t('errorReport.addToIssue')} <a href={safeIssueUrl(target.issueUrl)} target="_blank" rel="noreferrer">{target.title}</a></label>}
    </>}
    <label className="block"><input type="radio" name="issue-destination" checked={value.reviewed && !value.target} disabled={state === 'checking'} onChange={() => onChange({ reviewed: true })} /> {t('errorReport.newIssue')}</label>
  </div>;
}
