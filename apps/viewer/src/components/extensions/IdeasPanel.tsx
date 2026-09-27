/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IdeasPanel` — surface mined patterns as candidate one-click tools.
 *
 * The pattern miner runs on idle, scans the local action log, and emits
 * recurring intent sequences. This panel lists them with a per-pattern
 * "Author it" affordance: clicking turns the pattern into an
 * `AuthoringPlan` stub via `host.acceptSuggestion()`, then shows the
 * `PlanCard` so the user can prune / approve before chat routes it
 * through the bundle synthesis pipeline.
 *
 * Privacy: everything here is local. Patterns are derived from
 * content-free action metadata only.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §3.
 */

import { useEffect, useState } from 'react';
import { ArrowRight, Lightbulb, MessageSquarePlus, Sparkles, Wrench } from 'lucide-react';
import {
  STARTER_IDEAS,
  type AuthoringPlan,
  type MinedPattern,
  type MineEvent,
  type StarterIdea,
} from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { PlanCard } from './PlanCard';
import { toast } from '@/components/ui/toast';
import { HelpHint } from './HelpHint';
import { formatExtensionDate } from './localized-date';
import { styleInterpolatedValues } from '@/i18n/richInterpolate';
import { formatLocaleNumber } from '@/i18n/intlFormat';

interface IdeasPanelProps {
  /** Optional override for the approve action. Defaults to seeding the chat panel. */
  onApprovePlan?: (plan: AuthoringPlan) => void;
}

export function IdeasPanel({ onApprovePlan }: IdeasPanelProps) {
  const { t, locale } = useTranslation();
  const host = useExtensionHost();
  const queueChatPrompt = useViewerStore((s) => s.queueChatPrompt);
  const setChatPanelVisible = useViewerStore((s) => s.setChatPanelVisible);
  const setScriptPanelVisible = useViewerStore((s) => s.setScriptPanelVisible);
  const setScriptEditorContent = useViewerStore((s) => s.setScriptEditorContent);
  /** Deep-link from Command Palette → "Author from scratch". */
  const ideasOpenEmptyPlan = useViewerStore((s) => s.ideasOpenEmptyPlan);
  const setIdeasOpenEmptyPlan = useViewerStore((s) => s.setIdeasOpenEmptyPlan);
  const [event, setEvent] = useState<MineEvent | undefined>(() => host.getSuggestions());
  const [draft, setDraft] = useState<AuthoringPlan | undefined>();

  useEffect(() => {
    return host.onSuggestions((e) => setEvent(e));
  }, [host]);

  // Honour a deep-link request to open the empty-plan flow. The
  // flag is one-shot — clear it once we've opened the draft so a
  // tab switch doesn't reopen it.
  useEffect(() => {
    if (ideasOpenEmptyPlan) {
      handleAuthorFromScratch();
      setIdeasOpenEmptyPlan(false);
    }
    // handleAuthorFromScratch is defined below in this component and
    // stable across renders (no deps), so referencing it here is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ideasOpenEmptyPlan]);

  const patterns = event?.patterns ?? [];


  /**
   * Starter "Try it" routes directly to chat with the plan baked into
   * the prompt AND opens the Script Editor so the user sees where
   * generated code will land. We only seed the editor with a
   * placeholder when it's empty / on the default boilerplate —
   * clobbering a user's in-progress code would be hostile.
   */
  const handleAcceptStarter = (idea: StarterIdea) => {
    const prompt = buildAuthoringPrompt(idea.plan);
    queueChatPrompt(prompt);
    setChatPanelVisible(true);
    setScriptPanelVisible(true);
    const current = useViewerStore.getState().scriptEditorContent ?? '';
    const isPristine = current.trim().length === 0 || /Write your BIM script here/.test(current);
    if (isPristine) {
      setScriptEditorContent(
        `// Authoring: ${idea.plan.summary}\n` +
          `//\n` +
          `// The AI is reading the plan in the chat panel.\n` +
          `// Answer the follow-ups and the generated handler will land here.\n`,
      );
    }
    toast.success(t('extensionsPanels.ideasPanel.sentToChatToast', { summary: idea.plan.summary }));
  };

  /** Power-user path: open the PlanCard with the starter pre-filled. */
  const handleCustomizeStarter = (idea: StarterIdea) => {
    setDraft({ ...idea.plan });
  };

  /** Mined-pattern accept — always uses the PlanCard since the
   *  generated plan is rougher and benefits from review. */
  const handleAcceptMined = (pattern: MinedPattern) => {
    setDraft(host.acceptSuggestion(pattern));
  };

  /**
   * Open the Plan Card with an empty plan. The user describes the
   * extension in the plan fields before approval kicks off chat —
   * plan-before-code without needing a mined pattern or a starter.
   */
  const handleAuthorFromScratch = () => {
    setDraft({
      summary: '',
      rationale: '',
      contributions: [],
      capabilities: [],
      triggers: [],
      widgets: [],
      tests: [],
    });
  };

  const handleApprove = (plan: AuthoringPlan) => {
    setDraft(undefined);
    if (onApprovePlan) {
      onApprovePlan(plan);
      return;
    }
    // Default routing: open chat AND the script editor, then seed
    // chat with a prompt describing the approved plan. The script
    // panel is where the generated code lands — opening both keeps
    // this consistent with the "Try it" flow.
    queueChatPrompt(buildAuthoringPrompt(plan));
    setChatPanelVisible(true);
    setScriptPanelVisible(true);
    toast.success(t('extensionsPanels.ideasPanel.routingToChatToast', { summary: plan.summary }));
  };

  if (draft) {
    return (
      <div className="p-3">
        <PlanCard
          plan={draft}
          onApprove={handleApprove}
          onCancel={() => setDraft(undefined)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4" />
          <h2 className="text-sm font-semibold">{t('extensionsPanels.ideasPanel.title')}</h2>
          {event && (
            <span className="text-2xs text-muted-foreground">
              {t('extensionsPanels.ideasPanel.suggestionsSummary', {
                count: patterns.length,
                countDisplay: formatLocaleNumber(locale, patterns.length),
                events: formatLocaleNumber(locale, event.eventCount),
              })}
            </span>
          )}
          <HelpHint label={t('extensionsPanels.ideasPanel.helpLabel')}>
            <p>
              {styleInterpolatedValues(t, 'extensionsPanels.ideasPanel.helpCurated', [
                ['subject', <strong key="curated">{t('extensionsPanels.ideasPanel.helpCuratedSubject')}</strong>],
              ])}
            </p>
            <p>
              {styleInterpolatedValues(t, 'extensionsPanels.ideasPanel.helpRecurring', [
                ['subject', <strong key="recurring">{t('extensionsPanels.ideasPanel.helpRecurringSubject')}</strong>],
              ])}
            </p>
            <p>
              {styleInterpolatedValues(t, 'extensionsPanels.ideasPanel.helpActions', [
                ['tryIt', <strong key="try-it">{t('extensionsPanels.ideasPanel.tryItButton')}</strong>],
                ['customize', <strong key="customize">{t('extensionsPanels.ideasPanel.customizePlanLink')}</strong>],
              ])}
            </p>
            <p>{t('extensionsPanels.ideasPanel.helpPrivacy')}</p>
          </HelpHint>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const next = host.miner.fireNow();
            setEvent({ ...next });
          }}
          aria-label={t('extensionsPanels.ideasPanel.remineAriaLabel')}
        >
          <Sparkles className="mr-1 h-3.5 w-3.5" />
          {t('extensionsPanels.ideasPanel.remineButton')}
        </Button>
      </div>

      <div className="border-b px-4 py-2 text-xs text-muted-foreground">
        {t('extensionsPanels.ideasPanel.footerPrivacy')}
      </div>

      <ScrollArea className="flex-1">
        {/* Recurring (mined) patterns. Tightens as the log grows. */}
        {patterns.length > 0 && (
          <div>
            <div className="px-4 pt-3 pb-1 text-2xs uppercase tracking-wide font-semibold text-muted-foreground">
              {t('extensionsPanels.ideasPanel.recurringHeading')}
            </div>
            <ul className="divide-y">
              {patterns.map((pattern, i) => (
                <li key={`${pattern.sequence.join('>')}:${i}`} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1 text-xs">
                        {pattern.sequence.map((intent, idx) => (
                          <span key={`${intent}:${idx}`} className="flex items-center gap-1">
                            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs">
                              {intent}
                            </code>
                            {idx < pattern.sequence.length - 1 && (
                              <ArrowRight className="h-3 w-3 text-muted-foreground" />
                            )}
                          </span>
                        ))}
                      </div>
                      <div className="mt-1 text-2xs text-muted-foreground">
                        {t('extensionsPanels.ideasPanel.occurrenceSummary', {
                          count: pattern.sessionsTouched,
                          occurrences: formatLocaleNumber(locale, pattern.occurrences),
                          sessions: formatLocaleNumber(locale, pattern.sessionsTouched),
                          date: formatExtensionDate(pattern.lastSeenAt, locale),
                          score: formatLocaleNumber(locale, pattern.score, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          }),
                        })}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleAcceptMined(pattern)}
                      aria-label={t('extensionsPanels.ideasPanel.acceptMinedAriaLabel')}
                    >
                      <Wrench className="mr-1 h-3.5 w-3.5" />
                      {t('extensionsPanels.ideasPanel.authorItButton')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Always-on starter ideas. Hand-curated IFC/AEC workflows the
            user can author without waiting for the miner to learn from
            their activity. Tagged "Example" so they don't masquerade
            as personalised suggestions. */}
        <div>
          <div className="px-4 pt-4 pb-1 text-2xs uppercase tracking-wide font-semibold text-muted-foreground">
            {patterns.length === 0
              ? t('extensionsPanels.ideasPanel.gettingStartedEmpty')
              : t('extensionsPanels.ideasPanel.gettingStartedExamples')}
          </div>
          <ul className="divide-y">
            {STARTER_IDEAS.map((idea) => (
              <li key={idea.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs font-medium">
                      <span aria-hidden>{idea.icon}</span>
                      <span className="truncate">{idea.plan.summary}</span>
                      <span className="text-2xs uppercase tracking-wide bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-semibold shrink-0">
                        {idea.category}
                      </span>
                    </div>
                    <p className="mt-1 text-2xs text-muted-foreground leading-relaxed line-clamp-3">
                      {idea.plan.rationale}
                    </p>
                    <button
                      type="button"
                      onClick={() => handleCustomizeStarter(idea)}
                      className="mt-1 text-2xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                    >
                      {t('extensionsPanels.ideasPanel.customizePlanLink')}
                    </button>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleAcceptStarter(idea)}
                    aria-label={t('extensionsPanels.ideasPanel.sendToChatAriaLabel', { summary: idea.plan.summary })}
                    title={t('extensionsPanels.ideasPanel.sendToChatTitle')}
                    className="shrink-0"
                  >
                    <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />
                    {t('extensionsPanels.ideasPanel.tryItButton')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* "Author from scratch" CTA — opens the Plan Card with an
            empty plan so the user can describe whatever they want
            before chat takes over. */}
        <div className="px-4 py-4 border-t mt-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={handleAuthorFromScratch}
          >
            <MessageSquarePlus className="mr-2 h-3.5 w-3.5" />
            {t('extensionsPanels.ideasPanel.authorFromScratchButton')}
          </Button>
          <p className="mt-1 text-2xs text-muted-foreground">
            {t('extensionsPanels.ideasPanel.authorFromScratchBody')}
          </p>
        </div>
      </ScrollArea>
    </div>
  );
}

function buildAuthoringPrompt(plan: AuthoringPlan): string {
  const contributions = plan.contributions
    .map((c) => `- ${c.kind}: ${c.label}${c.slot ? ` (slot: ${c.slot})` : ''}`)
    .join('\n');
  const caps = plan.capabilities.map((c) => `\`${c}\``).join(', ') || '(none)';
  return [
    `Author an extension for me: ${plan.summary}`,
    '',
    `Rationale: ${plan.rationale}`,
    '',
    `Contributions:\n${contributions || '- (to be designed)'}`,
    '',
    `Capabilities requested: ${caps}`,
    `Triggers: ${plan.triggers.join(', ') || '(to be designed)'}`,
    plan.notes ? `\nNotes: ${plan.notes}` : '',
  ].filter(Boolean).join('\n');
}
