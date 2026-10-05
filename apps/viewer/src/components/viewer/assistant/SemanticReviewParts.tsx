/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { SpanCheck } from '@/lib/semantic/assist/spans';
import type { SourceSpan } from '@/lib/semantic/assist/proposal-common';

const SPAN_LABEL: Record<SpanCheck['status'], TranslationKey> = {
  verified: 'semanticAssist.spanVerified', mismatch: 'semanticAssist.spanMismatch', 'not-captured': 'semanticAssist.spanNotCaptured',
};
const SPAN_TONE: Record<SpanCheck['status'], string> = {
  verified: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  mismatch: 'bg-destructive/10 text-destructive', 'not-captured': 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
};

/** A quoted source span with its exact verification result; a mismatch shows what the source actually says. */
export function SpanQuote({ span, check }: { span: SourceSpan; check: SpanCheck }) {
  const { t } = useTranslation();
  return <div className="space-y-0.5">
    <p className="flex flex-wrap items-center gap-1 text-2xs">
      <span className={`rounded px-1 py-0.5 font-medium ${SPAN_TONE[check.status]}`}>{t(SPAN_LABEL[check.status])}</span>
      <span className="font-mono text-muted-foreground">{t('semanticAssist.spanAt', { source: span.source, start: span.start, end: span.end })}</span>
    </p>
    <blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-2">{span.quote}</blockquote>
    {check.status === 'mismatch' && <p className="text-2xs text-muted-foreground break-words">
      {t('semanticAssist.spanActual', { actual: check.actual })}{check.foundAt !== undefined ? ` ${t('semanticAssist.spanFoundAt', { offset: check.foundAt })}` : ''}
    </p>}
  </div>;
}

/** Shared card frame for the four semantic reviews. */
export function ReviewFrame({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return <section aria-label={label} className="mx-3 my-2 rounded border border-border p-2 text-xs space-y-2">
    <p className="font-semibold">{label}</p>
    <p className="break-words">{title}</p>
    {children}
  </section>;
}
