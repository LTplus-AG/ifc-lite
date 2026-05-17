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
import { PlanCard } from './PlanCard';
import { toast } from '@/components/ui/toast';
import { HelpHint } from './HelpHint';

interface IdeasPanelProps {
  /** Optional override for the approve action. Defaults to seeding the chat panel. */
  onApprovePlan?: (plan: AuthoringPlan) => void;
}

export function IdeasPanel({ onApprovePlan }: IdeasPanelProps) {
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
   * the prompt AND opens the Script Editor as the "viewport" where
   * the assistant's generated handler code shows up. Users on the
   * Vercel preview expected to see *something* land in code — opening
   * just chat without surfacing the editor read as "nothing happened".
   *
   * The editor gets a brief placeholder explaining what's coming so
   * the panel isn't blank while the model is still streaming.
   */
  const handleAcceptStarter = (idea: StarterIdea) => {
    const prompt = buildAuthoringPrompt(idea.plan);
    queueChatPrompt(prompt);
    setChatPanelVisible(true);
    setScriptPanelVisible(true);
    setScriptEditorContent(
      `// Authoring: ${idea.plan.summary}\n` +
        `//\n` +
        `// The AI assistant is reading the plan in the chat panel.\n` +
        `// After you approve follow-up questions, the generated handler\n` +
        `// code lands here. You can then Run it directly, or install it\n` +
        `// as an extension from the Extensions panel.\n`,
    );
    toast.success(`Sent "${idea.plan.summary}" to chat — answer follow-ups to refine.`);
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
          <HelpHint label="Ideas">
            <p>
              <strong>Curated starter ideas</strong> show what
              one-click tools you can build today.
            </p>
            <p>
              <strong>Recurring suggestions</strong> appear once a
              workflow shows up repeatedly in your local activity log
              (model loads, lens applies, exports). Thresholds relax
              while the log is sparse so something appears early;
              tightens as data accumulates.
            </p>
            <p>
              Click <strong>Try it</strong> to send the idea to the AI
              chat assistant — chat opens and you answer follow-ups.
              Click <strong>Customize plan first…</strong> if you want
              to prune capabilities or rename the command before chat
              sees it.
            </p>
            <p>The action log is local. Nothing here leaves your device.</p>
          </HelpHint>
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
        {/* Recurring (mined) patterns. Tightens as the log grows. */}
        {patterns.length > 0 && (
          <div>
            <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
              Recurring in your activity
            </div>
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
                      onClick={() => handleAcceptMined(pattern)}
                      aria-label="Author one-click tool from pattern"
                    >
                      <Wrench className="mr-1 h-3.5 w-3.5" />
                      Author it
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
          <div className="px-4 pt-4 pb-1 text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
            {patterns.length === 0 ? 'Try one of these to get started' : 'Examples — common AEC tools'}
          </div>
          <ul className="divide-y">
            {STARTER_IDEAS.map((idea) => (
              <li key={idea.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs font-medium">
                      <span aria-hidden>{idea.icon}</span>
                      <span className="truncate">{idea.plan.summary}</span>
                      <span className="text-[10px] uppercase tracking-wide bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-semibold shrink-0">
                        {idea.category}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed line-clamp-3">
                      {idea.plan.rationale}
                    </p>
                    <button
                      type="button"
                      onClick={() => handleCustomizeStarter(idea)}
                      className="mt-1 text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                    >
                      Customize plan first…
                    </button>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleAcceptStarter(idea)}
                    aria-label={`Send "${idea.plan.summary}" to chat`}
                    title="Sends a plan-based prompt to the AI chat assistant. Opens the chat panel."
                    className="shrink-0"
                  >
                    <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />
                    Try it
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
            Author an extension from scratch
          </Button>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Open an empty plan. Fill in what you want, then approve →
            chat AI assembles the bundle.
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
