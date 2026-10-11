/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One lint diagnostic (IDS-036): severity, code, message, the rule's rationale
 * on demand, and its quick fixes. A fix is previewed first (computed on a copy
 * of the document) and applied only on confirmation, through the gate, as one
 * undo step. Fixes are never applied automatically.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Info, OctagonX, Wrench } from 'lucide-react';
import type { Diagnostic, LintSeverity } from '@ifc-lite/ids-authoring';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { diagnosticKey, previewFix, rowIdOf } from '@/lib/ids-studio/diagnostics';
import { cn } from '@/lib/utils';

const ICON = { error: OctagonX, warning: AlertTriangle, info: Info } as const;
const TONE: Record<LintSeverity, string> = { error: 'text-destructive', warning: 'text-amber-600 dark:text-amber-400', info: 'text-sky-600 dark:text-sky-400' };
export const SEVERITY_LABEL: Record<LintSeverity, TranslationKey> = {
  error: 'idsStudio.diagnostics.severity.error', warning: 'idsStudio.diagnostics.severity.warning', info: 'idsStudio.diagnostics.severity.info',
};

export function SeverityIcon({ severity, className }: { severity: LintSeverity; className?: string }) {
  const { t } = useTranslation();
  const Icon = ICON[severity];
  return <span className={cn('inline-flex shrink-0', className)} title={t(SEVERITY_LABEL[severity])}>
    <Icon aria-hidden className={cn('h-3.5 w-3.5', TONE[severity])} />
    <span className="sr-only">{t(SEVERITY_LABEL[severity])}</span>
  </span>;
}

export function DiagnosticItem({ diagnostic, focusable = false }: { diagnostic: Diagnostic; focusable?: boolean }) {
  const { t } = useTranslation();
  const doc = useViewerStore((s) => s.idsStudioState?.doc ?? null);
  const locale = useViewerStore((s) => s.idsLocale);
  const preview = useViewerStore((s) => s.idsStudioFixPreview);
  const setPreview = useViewerStore((s) => s.idsStudioSetFixPreview);
  const dispatch = useViewerStore((s) => s.idsStudioDispatch);
  const select = useViewerStore((s) => s.idsStudioSelect);
  const [why, setWhy] = useState(false);
  const key = diagnosticKey(diagnostic);
  const fixIndex = preview?.key === key ? preview.fixIndex : null;
  const fix = fixIndex === null ? undefined : diagnostic.fixes?.[fixIndex];
  const changes = useMemo(() => (doc && fix ? previewFix(doc, fix, locale) : null), [doc, fix, locale]);
  const focus = () => { if (doc) select(rowIdOf(doc, diagnostic.nodeId)); };
  return <li className="space-y-1 rounded border border-border p-1.5 text-xs">
    <div className="flex items-start gap-1.5">
      <SeverityIcon severity={diagnostic.severity} className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-0.5">
        {focusable
          ? <button type="button" className="text-left hover:underline break-words" onClick={focus}>{diagnostic.message}</button>
          : <p className="break-words">{diagnostic.message}</p>}
        <p className="flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
          <a href={diagnostic.docsUrl} target="_blank" rel="noreferrer" className="font-mono hover:underline">{diagnostic.code}</a>
          {diagnostic.why && <button type="button" aria-expanded={why} className="hover:underline" onClick={() => setWhy((v) => !v)}>{t('idsStudio.diagnostics.why')}</button>}
        </p>
        {why && diagnostic.why && <p className="text-2xs text-muted-foreground break-words">{diagnostic.why}</p>}
      </div>
    </div>
    {!!diagnostic.fixes?.length && <div className="flex flex-wrap gap-1 pl-5">
      {diagnostic.fixes.map((option, index) => <Button key={index} size="sm" variant={fixIndex === index ? 'secondary' : 'outline'} className="h-6 px-2 text-2xs"
        aria-pressed={fixIndex === index} onClick={() => setPreview(fixIndex === index ? null : { key, fixIndex: index })}>
        <Wrench className="mr-1 h-3 w-3" aria-hidden />{option.label}
      </Button>)}
    </div>}
    {fix && changes && <section className="ml-5 space-y-1 rounded bg-muted/50 p-1.5" aria-label={t('idsStudio.diagnostics.previewLabel')}>
      <p className="text-2xs font-medium">{t('idsStudio.diagnostics.preview')}</p>
      {changes.ok
        ? changes.changes.length === 0
          ? <p className="text-2xs text-muted-foreground">{t('idsStudio.diagnostics.previewNoText')}</p>
          : <ul className="space-y-0.5">{changes.changes.map((change) => <li key={change.nodeId} className="text-2xs break-words">
            <span className="line-through text-muted-foreground">{change.before ?? t('idsStudio.diagnostics.previewNone')}</span>
            <ArrowRight className="mx-1 inline h-3 w-3" aria-hidden />
            <span>{change.after ?? t('idsStudio.diagnostics.previewRemoved')}</span>
          </li>)}</ul>
        : <p className="text-2xs text-destructive">{changes.message}</p>}
      <div className="flex gap-1">
        <Button size="sm" className="h-6 px-2 text-2xs" disabled={!changes.ok}
          onClick={() => { if (dispatch(fix.ops, { label: fix.label }).ok) setPreview(null); }}>{t('idsStudio.diagnostics.applyFix')}</Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-2xs" onClick={() => setPreview(null)}>{t('idsStudio.diagnostics.cancelFix')}</Button>
      </div>
    </section>}
  </li>;
}
