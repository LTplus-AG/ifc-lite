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
import { ArrowRight, Lightbulb, Sparkles, Wrench } from 'lucide-react';
import type {
  AuthoringPlan,
  MinedPattern,
  MineEvent,
} from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { PlanCard } from './PlanCard';
import { toast } from '@/components/ui/toast';

interface IdeasPanelProps {
  /** Optional override for the approve action. Defaults to seeding the chat panel. */
  onApprovePlan?: (plan: AuthoringPlan) => void;
}

export function IdeasPanel({ onApprovePlan }: IdeasPanelProps) {
  const host = useExtensionHost();
  const queueChatPrompt = useViewerStore((s) => s.queueChatPrompt);
  const setChatPanelVisible = useViewerStore((s) => s.setChatPanelVisible);
  const [event, setEvent] = useState<MineEvent | undefined>(() => host.getSuggestions());
  const [draft, setDraft] = useState<AuthoringPlan | undefined>();

  useEffect(() => {
    return host.onSuggestions((e) => setEvent(e));
  }, [host]);

  const patterns = event?.patterns ?? [];

  const handleAccept = (pattern: MinedPattern) => {
    setDraft(host.acceptSuggestion(pattern));
  };

  const handleApprove = (plan: AuthoringPlan) => {
    setDraft(undefined);
    if (onApprovePlan) {
      onApprovePlan(plan);
      return;
    }
    // Default routing: open chat and seed it with a prompt that
    // describes the approved plan. The chat panel picks up the
    // pending prompt and starts an authoring turn.
    queueChatPrompt(buildAuthoringPrompt(plan));
    setChatPanelVisible(true);
    toast.success(`Routing "${plan.summary}" to the AI assistant…`);
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
          <h2 className="text-sm font-semibold">Ideas</h2>
          {event && (
            <span className="text-[11px] text-muted-foreground">
              {patterns.length} {patterns.length === 1 ? 'suggestion' : 'suggestions'}
              {' · '}
              {event.eventCount} events
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const next = host.miner.fireNow();
            setEvent({ ...next });
          }}
          aria-label="Re-mine now"
        >
          <Sparkles className="mr-1 h-3.5 w-3.5" />
          Re-mine
        </Button>
      </div>

      <div className="border-b px-4 py-2 text-xs text-muted-foreground">
        Recurring sequences in your local activity log. Nothing here leaves your device.
      </div>

      <ScrollArea className="flex-1">
        {patterns.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <Lightbulb className="h-8 w-8 text-muted-foreground" />
            <div className="text-sm font-medium">No suggestions yet</div>
            <div className="text-xs text-muted-foreground max-w-xs">
              Keep working — once a workflow repeats a few times across
              sessions, it will appear here as a candidate one-click tool.
            </div>
          </div>
        ) : (
          <ul className="divide-y">
            {patterns.map((pattern, i) => (
              <li key={`${pattern.sequence.join('>')}:${i}`} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1 text-xs">
                      {pattern.sequence.map((intent, idx) => (
                        <span key={`${intent}:${idx}`} className="flex items-center gap-1">
                          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                            {intent}
                          </code>
                          {idx < pattern.sequence.length - 1 && (
                            <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          )}
                        </span>
                      ))}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {pattern.occurrences}× across {pattern.sessionsTouched}{' '}
                      {pattern.sessionsTouched === 1 ? 'session' : 'sessions'}
                      {' · last '}
                      {new Date(pattern.lastSeenAt).toLocaleString()}
                      {' · score '}
                      {pattern.score.toFixed(2)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleAccept(pattern)}
                    aria-label="Author one-click tool from pattern"
                  >
                    <Wrench className="mr-1 h-3.5 w-3.5" />
                    Author it
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
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
