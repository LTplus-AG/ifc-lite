/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Compare panel's analysis sections (#6921): the comparison's impact on
 * the other loaded analyses, and cross-revision reconciliation of captured
 * runs. Mounted at the top of the change list's scroll pane, collapsed, so
 * they scroll with the list instead of taking height from it.
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useTranslation } from '@/i18n';
import type { CompareResult } from '@/store/slices/compareSlice';
import { CompareImpactSection } from './CompareImpactSection';
import { CompareReconcileSection } from './CompareReconcileSection';
import { useCompareImpact } from './useCompareImpact';

function Section({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium hover:bg-muted/50 transition-colors">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span>{title}</span>
          {badge}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function CompareAnalysisSections({ result }: { result: CompareResult }) {
  const { t } = useTranslation();
  const view = useCompareImpact();
  const impact = view?.impact;
  const touched = impact ? impact.totals.clash + impact.totals.validation + impact.totals.list + impact.totals.bcf : 0;
  return (
    <section aria-label={t('compareAnalysis.sectionsLabel')} className="border-b border-border">
      {impact && view && (
        <Section title={t('compareAnalysis.impact.title')}
          badge={<span className="ml-auto rounded bg-muted px-1.5 tabular-nums text-muted-foreground">{touched}</span>}>
          <CompareImpactSection impact={impact} navigation={view.navigation} />
        </Section>
      )}
      <Section title={t('compareAnalysis.reconcile.title')}>
        <CompareReconcileSection result={result} />
      </Section>
    </section>
  );
}
