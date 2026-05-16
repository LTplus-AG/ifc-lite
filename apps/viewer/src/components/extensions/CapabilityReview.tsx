/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `CapabilityReview` — modal dialog the user must confirm before any
 * extension is installed.
 *
 * Sources the capability list from the bundle's manifest, parses each
 * capability, runs the risk classifier, and surfaces a per-row badge
 * with a plain-English description. The user can:
 *
 *   - Approve every capability (default).
 *   - Uncheck individual capabilities they don't want to grant.
 *     The host enforces these at runtime via the inner-ring check;
 *     extensions that need them fail visibly.
 *   - Cancel.
 *
 * For red-tier capabilities we require the user to type "approve" as
 * a friction layer — matching the threat-model recommendation in
 * `02-security.md §4`.
 *
 * The dialog is purely presentational: it returns a grant decision to
 * the parent via `onApprove(grants)` / `onCancel()`. The parent is
 * responsible for calling `host.installFromBytes(bytes, grants)`.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileCode2, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { BundlePreview } from './BundlePreview';
import {
  computeRisks,
  overallTier,
  parseCapability,
  type Capability,
  type CapabilityRisk,
  type RiskTier,
} from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { ExtensionInstallSummary } from '@/services/extensions/host.js';

interface CapabilityReviewProps {
  open: boolean;
  summary: ExtensionInstallSummary;
  onApprove(grants: string[]): void;
  onCancel(): void;
}

interface CapabilityRow {
  raw: string;
  capability: Capability | null;
  risk: CapabilityRisk | null;
}

const APPROVE_PHRASE = 'approve';

export function CapabilityReview({ open, summary, onApprove, onCancel }: CapabilityReviewProps) {
  const rows = useMemo<CapabilityRow[]>(() => {
    return summary.capabilities.map((raw) => {
      const parsed = parseCapability(raw);
      if (!parsed.ok) return { raw, capability: null, risk: null };
      const [risk] = computeRisks([parsed.value]);
      return { raw, capability: parsed.value, risk };
    });
  }, [summary]);

  const overall = useMemo<RiskTier>(() => {
    return overallTier(rows.map((r) => r.risk).filter((r): r is CapabilityRisk => !!r));
  }, [rows]);

  const [granted, setGranted] = useState<Set<string>>(
    () => new Set(summary.capabilities),
  );
  const [confirmText, setConfirmText] = useState('');
  const [tab, setTab] = useState<'capabilities' | 'source'>('capabilities');

  const needsConfirm = useMemo(() => {
    for (const row of rows) {
      if (row.risk?.tier === 'red' && granted.has(row.raw)) return true;
    }
    return false;
  }, [rows, granted]);

  const canApprove =
    !needsConfirm || confirmText.trim().toLowerCase() === APPROVE_PHRASE;

  const toggle = (raw: string, checked: boolean) => {
    setGranted((prev) => {
      const next = new Set(prev);
      if (checked) next.add(raw);
      else next.delete(raw);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <RiskIcon tier={overall} />
            <DialogTitle>
              Install <span className="font-mono text-base">{summary.id}</span> v{summary.version}?
            </DialogTitle>
          </div>
          <DialogDescription>
            Review the capabilities this extension is requesting. Uncheck any
            you do not want to grant. Extensions that rely on a denied
            capability will surface a clear error at runtime instead of running
            silently with broader scope.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1 border-b">
          <button
            type="button"
            onClick={() => setTab('capabilities')}
            className={cn(
              'flex items-center gap-1 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors',
              tab === 'capabilities'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Capabilities
          </button>
          <button
            type="button"
            onClick={() => setTab('source')}
            className={cn(
              'flex items-center gap-1 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors',
              tab === 'source'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <FileCode2 className="h-3.5 w-3.5" />
            Source
          </button>
        </div>

        {tab === 'source' ? (
          <BundlePreview bundle={summary.bundle} />
        ) : (
        <ScrollArea className="max-h-72 rounded-md border">
          <ul className="divide-y">
            {rows.length === 0 && (
              <li className="px-4 py-3 text-sm text-muted-foreground">
                This extension requests no capabilities — viewer-only chrome.
              </li>
            )}
            {rows.map((row) => (
              <li key={row.raw} className="flex items-start gap-3 px-4 py-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={granted.has(row.raw)}
                  onChange={(e) => toggle(row.raw, e.target.checked)}
                  aria-label={`Grant capability ${row.raw}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono">{row.raw}</code>
                    <RiskBadge tier={row.risk?.tier ?? 'red'} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.risk?.description ?? 'Unknown capability — treated as high-risk.'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
        )}

        {needsConfirm && tab === 'capabilities' && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm">
            <div className="font-medium text-destructive flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              High-risk capability requested
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Type <code className="font-mono">{APPROVE_PHRASE}</code> below to confirm.
            </p>
            <Input
              className="mt-2"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="approve"
              aria-label="Type approve to confirm"
              autoFocus
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            <X className="mr-1 h-4 w-4" />
            Cancel
          </Button>
          <Button
            disabled={!canApprove}
            onClick={() => onApprove(Array.from(granted))}
          >
            <CheckCircle2 className="mr-1 h-4 w-4" />
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RiskIcon({ tier }: { tier: RiskTier }) {
  if (tier === 'red') return <ShieldAlert className="h-5 w-5 text-destructive" />;
  if (tier === 'yellow') return <AlertTriangle className="h-5 w-5 text-amber-500" />;
  return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
}

function RiskBadge({ tier }: { tier: RiskTier }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        tier === 'red' && 'bg-destructive/20 text-destructive',
        tier === 'yellow' && 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
        tier === 'green' && 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400',
      )}
    >
      {tier}
    </span>
  );
}
