/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PlanCard` — render an AuthoringPlan with edit affordances.
 *
 * The plan-before-code UX: the AI proposes a structured plan; the user
 * trims contributions, prunes capabilities, edits the summary, then
 * approves. After approval, the chat panel routes through the actual
 * bundle synthesis (a follow-up that consumes this card's `onApprove`).
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §4.
 */

import { useMemo, useState } from 'react';
import { Check, ChevronRight, Edit3, ShieldAlert, Sparkles, X } from 'lucide-react';
import {
  computeRisks,
  overallTier,
  parseCapability,
  type AuthoringPlan,
  type CapabilityRisk,
  type RiskTier,
} from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface PlanCardProps {
  /** The plan to show. Editable copy is stored in component state. */
  plan: AuthoringPlan;
  /** Called when the user confirms the (possibly edited) plan. */
  onApprove(plan: AuthoringPlan): void;
  /** Called when the user cancels / dismisses. */
  onCancel(): void;
  /** Hide the inline edit fields. Useful for read-only review of past plans. */
  readOnly?: boolean;
}

export function PlanCard({ plan, onApprove, onCancel, readOnly }: PlanCardProps) {
  const [draft, setDraft] = useState<AuthoringPlan>(plan);
  const risks = useMemo<CapabilityRisk[]>(() => {
    const parsed = draft.capabilities
      .map((raw) => parseCapability(raw))
      .filter((r): r is { ok: true; value: ReturnType<typeof parseCapability> extends { ok: true; value: infer V } ? V : never } => r.ok)
      .map((r) => r.value);
    return computeRisks(parsed);
  }, [draft.capabilities]);
  const overall = overallTier(risks);

  const toggleCapability = (raw: string) => {
    setDraft((p) => ({
      ...p,
      capabilities: p.capabilities.includes(raw)
        ? p.capabilities.filter((c) => c !== raw)
        : [...p.capabilities, raw],
    }));
  };

  const removeContribution = (idx: number) => {
    setDraft((p) => ({
      ...p,
      contributions: p.contributions.filter((_, i) => i !== idx),
    }));
  };

  return (
    <div className={cn(
      'rounded-lg border bg-card p-4 space-y-3',
      overall === 'red' && 'border-destructive/50',
      overall === 'yellow' && 'border-amber-500/40',
    )}>
      <div className="flex items-start gap-2">
        <div className={cn(
          'mt-1 p-1.5 rounded-md',
          overall === 'red' ? 'bg-destructive/20 text-destructive' : overall === 'yellow' ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400' : 'bg-primary/20 text-primary',
        )}>
          {overall === 'red' ? <ShieldAlert className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">
            Authoring plan
          </div>
          {readOnly ? (
            <div className="text-sm font-medium">{draft.summary}</div>
          ) : (
            <Input
              value={draft.summary}
              onChange={(e) => setDraft((p) => ({ ...p, summary: e.target.value }))}
              className="mt-1 text-sm font-medium"
              aria-label="Plan summary"
            />
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">{draft.rationale}</p>

      <div className="space-y-1.5">
        <Label className="text-[11px] uppercase tracking-wide">Contributions</Label>
        {draft.contributions.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">No contributions.</div>
        ) : (
          <ul className="space-y-1">
            {draft.contributions.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-xs rounded-md border bg-muted/30 px-2 py-1.5">
                <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="font-mono uppercase text-[10px] text-muted-foreground shrink-0">{c.kind}</span>
                <span className="flex-1 min-w-0 truncate">{c.label}</span>
                {c.slot && (
                  <code className="text-[10px] text-muted-foreground font-mono">{c.slot}</code>
                )}
                {!readOnly && (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => removeContribution(i)}
                    aria-label={`Remove contribution ${i}`}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1.5">
        <Label className="text-[11px] uppercase tracking-wide">Capabilities</Label>
        {draft.capabilities.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">No capabilities requested.</div>
        ) : (
          <ul className="space-y-1">
            {risks.map((risk) => (
              <li
                key={risk.capability.raw}
                className="flex items-start gap-2 text-xs rounded-md border bg-muted/30 px-2 py-1.5"
              >
                {!readOnly && (
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={draft.capabilities.includes(risk.capability.raw)}
                    onChange={() => toggleCapability(risk.capability.raw)}
                    aria-label={`Toggle capability ${risk.capability.raw}`}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-[10px]">{risk.capability.raw}</code>
                    <RiskBadge tier={risk.tier} />
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {risk.description}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1.5">
        <Label className="text-[11px] uppercase tracking-wide">Triggers</Label>
        <div className="flex flex-wrap gap-1">
          {draft.triggers.map((t) => (
            <code key={t} className="text-[10px] font-mono rounded bg-muted px-1.5 py-0.5">{t}</code>
          ))}
        </div>
      </div>

      {draft.tests.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-[11px] uppercase tracking-wide">Tests</Label>
          <ul className="space-y-1">
            {draft.tests.map((t, i) => (
              <li key={i} className="text-xs rounded-md border bg-muted/30 px-2 py-1.5">
                <div className="font-medium">{t.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  Fixture: <code className="font-mono">{t.fixture}</code>
                </div>
                <div className="text-[11px] text-muted-foreground italic mt-0.5">
                  {t.assertionSummary}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {draft.notes && (
        <div className="text-[11px] text-muted-foreground italic border-l-2 border-muted pl-2">
          {draft.notes}
        </div>
      )}

      {!readOnly && (
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <X className="mr-1 h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button size="sm" onClick={() => onApprove(draft)}>
            <Check className="mr-1 h-3.5 w-3.5" />
            Author it
          </Button>
        </div>
      )}
    </div>
  );
}

function RiskBadge({ tier }: { tier: RiskTier }) {
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
      tier === 'red' && 'bg-destructive/20 text-destructive',
      tier === 'yellow' && 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
      tier === 'green' && 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400',
    )}>
      {tier}
    </span>
  );
}
