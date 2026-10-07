/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { cardTitle } from '@/lib/review/bcf-draft';
import type { CoordinationCard } from '@/lib/review/cards';
import { openOriginal, selectCardElements } from '@/lib/review/open';
import { pinReviewCard } from '@/lib/review/assistant';
import type { CardDecision } from '@/lib/review/workspace';
import type { ReviewFinding } from '@/lib/review/types';
import type { WorkspacePanelId } from '@/lib/panels/registry';
import { usePanelControls } from '@/hooks/usePanelControls';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence } from '@/lib/assistant/conversation';
import { ReviewDecision } from './ReviewDecision';
import { HUMAN_STATUS_KEY, LIFECYCLE_KEY, SOURCE_KEY, STATE_HELP_KEY, STATE_KEY, gapText } from './review-labels';

const CHIP = 'inline-flex items-center rounded border border-border px-1.5 py-px text-2xs';

function FindingItem({ finding, openPanel }: { finding: ReviewFinding; openPanel: (panel: WorkspacePanelId) => void }) {
  const { t } = useTranslation();
  const historical = finding.run.temporal === 'historical';
  const [originalUnavailable, setOriginalUnavailable] = useState(false);
  return (
    <li className="space-y-0.5 rounded border border-border p-1.5 text-2xs" data-finding-source={finding.source} data-run-temporal={finding.run.temporal}>
      <div className="flex flex-wrap items-center gap-1">
        <span className={CHIP}>{t(SOURCE_KEY[finding.source])}</span>
        <span className={cn(CHIP, historical && 'border-dashed')}>{t(historical ? 'reviewWorkspace.temporal.historical' : 'reviewWorkspace.temporal.current')}</span>
        <span className="text-muted-foreground">{t(LIFECYCLE_KEY[finding.lifecycle])}</span>
      </div>
      <p className="text-xs font-medium break-words">{finding.title}</p>
      <p className="text-muted-foreground">{t('reviewWorkspace.nativeStatus', { status: finding.nativeStatus || t('reviewWorkspace.noStatus') })} · {finding.run.label}</p>
      {finding.run.incomplete.length > 0 && <p className="text-amber-600 dark:text-amber-400">{t('reviewWorkspace.incompleteRun', { reasons: gapText(t, finding.run.incomplete) })}</p>}
      {finding.detail.map((line, index) => <p key={index} className="text-muted-foreground break-words">{line}</p>)}
      <Button size="sm" variant="outline" aria-label={t('reviewWorkspace.openLabel', { source: t(SOURCE_KEY[finding.source]), title: finding.title })}
        onClick={() => setOriginalUnavailable(!openOriginal(finding, openPanel))}>{t('reviewWorkspace.open')}</Button>
      {originalUnavailable && <p role="alert">{t('reviewWorkspace.originalUnavailable')}</p>}
    </li>
  );
}

export function ReviewCard({ card, titles, decision, expanded, selected, onToggle, onSelect, onOpenRelated, onDraft }: {
  card: CoordinationCard; titles: ReadonlyMap<string, string>; decision: CardDecision | null; expanded: boolean; selected: boolean;
  onToggle: () => void; onSelect: (on: boolean) => void; onOpenRelated: (key: string) => void; onDraft: () => void;
}) {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const title = cardTitle(card);
  const openPanel = (panel: WorkspacePanelId) => panels.openInHome(panel, 'context');
  const ask = () => { pinReviewCard(card, decision); replaceEvidence(captureEvidence('review')); panels.openInHome('assistant', 'context'); };
  return (
    <li className="border-b border-border" data-review-card data-card-state={card.state} data-card-identity={card.identity}>
      <div className="flex items-start gap-1.5 px-3 py-2">
        <Checkbox checked={selected} onCheckedChange={onSelect} aria-label={t('reviewWorkspace.card.select', { title })} />
        <button type="button" aria-expanded={expanded} onClick={onToggle}
          aria-label={t(expanded ? 'reviewWorkspace.card.collapse' : 'reviewWorkspace.card.expand', { title })}
          className="flex min-w-0 flex-1 items-start gap-1 rounded text-left focus-visible:outline focus-visible:outline-2">
          {expanded ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          <span className="min-w-0 space-y-1">
            <span className="block text-xs font-medium break-words">{title}</span>
            <span className="flex flex-wrap items-center gap-1">
              <span className={CHIP}>{t(STATE_KEY[card.state])}</span>
              {card.sources.map(source => <span key={source} className={CHIP}>{t(SOURCE_KEY[source])}</span>)}
              <span className="text-2xs text-muted-foreground tabular-nums">{t('reviewWorkspace.card.findings', { count: card.findings.length })}</span>
              {decision && <span className={cn(CHIP, 'bg-muted')}>{t(HUMAN_STATUS_KEY[decision.status])}</span>}
            </span>
          </span>
        </button>
      </div>
      {expanded && (
        <div className="space-y-2 px-3 pb-3 pl-9">
          <p className="text-2xs text-muted-foreground">{t(STATE_HELP_KEY[card.state])}</p>
          {card.identity === 'unvalidated' && <p className="text-2xs text-amber-600 dark:text-amber-400">{t('reviewWorkspace.unvalidatedCard')}</p>}
          <section aria-label={t('reviewWorkspace.card.elements')}>
            <h4 className="text-xs font-medium">{t('reviewWorkspace.card.elements')}</h4>
            <ul className="text-2xs text-muted-foreground">
              {card.elements.map(element => <li key={`${element.modelName}${element.globalId}`} className="break-all">
                {element.key ? t('reviewWorkspace.card.element', { type: element.ifcType ?? 'IFC', name: element.name ?? '', globalId: element.globalId, model: element.modelName ?? '' })
                  : t('reviewWorkspace.card.elementUnvalidated', { globalId: element.globalId, identity: element.resolution })}</li>)}
            </ul>
          </section>
          <section aria-label={t('reviewWorkspace.card.findingsHeading')}>
            <h4 className="text-xs font-medium">{t('reviewWorkspace.card.findingsHeading')}</h4>
            <ul className="space-y-1">{card.findings.map(finding => <FindingItem key={finding.id} finding={finding} openPanel={openPanel} />)}</ul>
          </section>
          {card.related.length > 0 && (
            <section aria-label={t('reviewWorkspace.card.related')}>
              <h4 className="text-xs font-medium">{t('reviewWorkspace.card.related')}</h4>
              <ul className="flex flex-wrap gap-1">{card.related.map(key => (
                <li key={key}><Button size="sm" variant="outline" aria-label={t('reviewWorkspace.card.openRelated', { title: titles.get(key) ?? key })}
                  onClick={() => onOpenRelated(key)}>{titles.get(key) ?? key}</Button></li>))}</ul>
            </section>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" disabled={card.identity !== 'validated'} onClick={() => selectCardElements(card)}
              title={card.identity === 'validated' ? undefined : t('reviewWorkspace.selectIn3dNone')}>{t('reviewWorkspace.selectIn3d')}</Button>
            <Button size="sm" variant="outline" onClick={ask}><Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{t('reviewWorkspace.ask')}</Button>
            <Button size="sm" variant="outline" onClick={onDraft}>{t('reviewWorkspace.draftOne')}</Button>
          </div>
          <ReviewDecision key={`${card.key}:${decision?.updatedAt ?? ''}`} cardKey={card.key} decision={decision} />
        </div>
      )}
    </li>
  );
}
