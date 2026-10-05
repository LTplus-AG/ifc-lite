/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { getModelById } from '@/lib/llm/models';
import { useRequestReceipts, type UsageReceipt } from '@/lib/llm/request-receipts';
import { fetchUsageSnapshot } from '@/lib/llm/usage-quota';
import type { UsageInfo } from '@/lib/llm/stream-client';

/** Compact per-answer footer: provider-reported tokens, or an explicit "not reported". */
export function ReceiptFooter({ receipt }: { receipt: UsageReceipt }) {
  const { t, locale } = useTranslation();
  const seconds = formatLocaleNumber(locale, Math.max(0, receipt.finishedAt - receipt.startedAt) / 1000, { maximumFractionDigits: 1 });
  return <p className="mt-1 text-2xs text-muted-foreground tabular-nums">
    {receipt.usageReported
      ? t('assistantUsage.receiptTokens', { input: formatLocaleNumber(locale, receipt.inputTokens), output: formatLocaleNumber(locale, receipt.outputTokens), seconds })
      : t('assistantUsage.receiptUnreported', { seconds })}
  </p>;
}

function lastAnsweredProxyRequest(receipts: UsageReceipt[]): string | undefined {
  for (let i = receipts.length - 1; i >= 0; i--) {
    const r = receipts[i];
    if (r.route === 'proxy' && (r.outcome === 'completed' || r.outcome === 'truncated')) return r.id;
  }
  return undefined;
}

type Quota = { status: 'checking' } | { status: 'known'; usage: UsageInfo } | { status: 'unknown' };

/**
 * Remaining hosted-proxy requests, shown only while a free proxy model is
 * selected. Checked on open and after each answered proxy request; a failed
 * check reads "unknown" rather than disappearing.
 */
export function FreeQuotaNote({ model, proxyUrl }: { model: string; proxyUrl: string }) {
  const { t, locale } = useTranslation();
  const entry = getModelById(model);
  const free = entry?.tier === 'free' && entry.source === 'proxy';
  const answered = useRequestReceipts(s => lastAnsweredProxyRequest(s.receipts));
  const [quota, setQuota] = useState<Quota>({ status: 'checking' });
  useEffect(() => {
    if (!free) return;
    let cancelled = false;
    setQuota({ status: 'checking' });
    fetchUsageSnapshot(proxyUrl).then(result => {
      if (!cancelled) setQuota(result.ok ? { status: 'known', usage: result.usage } : { status: 'unknown' });
    }, (error: unknown) => {
      console.warn('[Assistant] free request quota check failed', error);
      if (!cancelled) setQuota({ status: 'unknown' });
    });
    return () => { cancelled = true; };
  }, [free, proxyUrl, answered]);
  if (!free) return null;
  return <p className="text-2xs text-muted-foreground tabular-nums">
    {quota.status === 'known'
      ? t('assistantUsage.freeRemaining', { remaining: formatLocaleNumber(locale, Math.max(0, quota.usage.limit - quota.usage.used)), limit: formatLocaleNumber(locale, quota.usage.limit) })
      : t(quota.status === 'checking' ? 'assistantUsage.freeChecking' : 'assistantUsage.freeUnknown')}
  </p>;
}
