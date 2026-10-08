/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared pieces of the check-authoring review cards (#6915). */

import type { ReactNode } from 'react';
import { CircleSlash } from 'lucide-react';
import { useTranslation } from '@/i18n';
import type { UnsupportedRequirement } from '@/lib/check-authoring/proposal-json';

/** Requirements no native engine checks: always shown, and stored with the saved draft. */
export function UnsupportedList({ items }: { items: readonly UnsupportedRequirement[] }) {
  const { t } = useTranslation();
  if (!items.length) return null;
  return <section aria-label={t('checkAuthoring.unsupportedTitle')} className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1">
    <p className="flex items-center gap-1 font-medium"><CircleSlash className="h-3.5 w-3.5" aria-hidden="true" />{t('checkAuthoring.unsupportedTitle')}</p>
    <p className="text-muted-foreground">{t('checkAuthoring.unsupportedHint')}</p>
    <ol className="list-decimal pl-4 space-y-0.5">{items.map((item, index) => <li key={index} className="break-words">
      {item.text} <span className="text-muted-foreground">{item.relatesTo
        ? t('checkAuthoring.unsupportedReasonFor', { reason: item.reason, name: item.relatesTo })
        : t('checkAuthoring.unsupportedReason', { reason: item.reason })}</span>
    </li>)}</ol>
  </section>;
}

export function ReviewCard({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return <section aria-label={label} className="mx-3 my-2 rounded border border-border text-xs">
    <h3 className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 font-semibold">{icon}{label}</h3>
    <div className="p-2 space-y-2">{children}</div>
  </section>;
}

export function TextField({ id, label, value, onChange, disabled, multiline }: {
  id: string; label: string; value: string; onChange: (value: string) => void; disabled?: boolean; multiline?: boolean;
}) {
  const className = 'w-full min-w-0 rounded border border-input bg-background px-2 py-1 disabled:opacity-60';
  return <div className="space-y-0.5">
    <label htmlFor={id} className="text-2xs text-muted-foreground">{label}</label>
    {multiline
      ? <textarea id={id} rows={3} className={className} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} />
      : <input id={id} className={`${className} h-7`} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} />}
  </div>;
}

export function Notice({ tone, children }: { tone: 'error' | 'success' | 'warning'; children: ReactNode }) {
  const tones = { error: 'border-destructive/40 bg-destructive/10 text-destructive', success: 'border-emerald-500/40 bg-emerald-500/10',
    warning: 'border-amber-500/40 bg-amber-500/10' };
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded border p-2 space-y-1.5 break-words ${tones[tone]}`}>{children}</div>;
}
