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
import { AlertTriangle, CheckCircle2, FileCode2, ShieldAlert, ShieldCheck, X, KeyRound, Unlock } from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslation } from '@/i18n';
import { styleInterpolatedValues } from '@/i18n/richInterpolate';
import { cn } from '@/lib/utils';
import type { ExtensionInstallSummary } from '@/services/extensions/host.js';
import { localizeCapabilityRisk, localizeRiskTier } from './localized-capability-risk';
import { formatExtensionDate } from './localized-date';

interface CapabilityReviewProps {
  open: boolean;
  summary: ExtensionInstallSummary;
  /** When supplied, render the capability diff vs the previously-granted set. */
  previousGrants?: readonly string[];
  /** Optional previous version label (e.g. "v1.2.0") for the diff banner. */
  previousVersion?: string;
  onApprove(grants: string[]): void;
  onCancel(): void;
}

interface CapabilityRow {
  raw: string;
  capability: Capability | null;
  risk: CapabilityRisk | null;
}

const APPROVE_PHRASE = 'approve';

export function CapabilityReview({
  open,
  summary,
  previousGrants,
  previousVersion,
  onApprove,
  onCancel,
}: CapabilityReviewProps) {
  const { t, locale } = useTranslation();
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

  /** Capability strings introduced since the previous install, if any. */
  const newSinceUpgrade = useMemo<Set<string>>(() => {
    if (!previousGrants) return new Set();
    const prior = new Set(previousGrants);
    return new Set(summary.capabilities.filter((c) => !prior.has(c)));
  }, [previousGrants, summary.capabilities]);

  /** Capability strings the new bundle no longer requests. */
  const droppedSinceUpgrade = useMemo<string[]>(() => {
    if (!previousGrants) return [];
    const next = new Set(summary.capabilities);
    return previousGrants.filter((c) => !next.has(c));
  }, [previousGrants, summary.capabilities]);

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
              {t('extensionsPanels.capabilityReview.installTitle', {
                id: summary.id, version: summary.version,
              })}
            </DialogTitle>
          </div>
          <DialogDescription>
            {t('extensionsPanels.capabilityReview.description')}
          </DialogDescription>
        </DialogHeader>

        {summary.signed && summary.signature ? (
          <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs">
            <KeyRound className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium text-emerald-700 dark:text-emerald-400">
                {t('extensionsPanels.capabilityReview.signatureVerifiedTitle')}
              </div>
              <div className="text-muted-foreground mt-0.5">
                {styleInterpolatedValues(t, 'extensionsPanels.capabilityReview.signedByLabel', [[
                  'fingerprint',
                  <code key="fingerprint" className="font-mono text-xs" title={summary.signature.fingerprint}>
                    {summary.signature.fingerprint.slice(0, 23)}…
                  </code>,
                ]], { date: formatExtensionDate(summary.signature.signedAt, locale) })}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            <Unlock className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium text-amber-700 dark:text-amber-400">
                {t('extensionsPanels.capabilityReview.unsignedTitle')}
              </div>
              <div className="text-muted-foreground mt-0.5">
                {t('extensionsPanels.capabilityReview.unsignedBody')}
              </div>
            </div>
          </div>
        )}

        {previousGrants && (newSinceUpgrade.size > 0 || droppedSinceUpgrade.length > 0) && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            <div className="font-medium text-amber-700 dark:text-amber-400">
              {t('extensionsPanels.capabilityReview.capabilityChangesSince', {
                version: previousVersion ?? t('extensionsPanels.capabilityReview.previousVersionFallback'),
              })}
            </div>
            {newSinceUpgrade.size > 0 && (
              <div className="mt-1">
                <span className="text-xs uppercase tracking-wide font-semibold text-amber-600">
                  {t('extensionsPanels.capabilityReview.newLabel')}
                </span>{' '}
                {[...newSinceUpgrade].map((c) => (
                  <code key={c} className="font-mono text-xs mr-1 bg-amber-500/20 rounded px-1 py-0.5">
                    {c}
                  </code>
                ))}
              </div>
            )}
            {droppedSinceUpgrade.length > 0 && (
              <div className="mt-1">
                <span className="text-xs uppercase tracking-wide font-semibold text-amber-600">
                  {t('extensionsPanels.capabilityReview.droppedLabel')}
                </span>{' '}
                {droppedSinceUpgrade.map((c) => (
                  <code key={c} className="font-mono text-xs mr-1 line-through opacity-70">
                    {c}
                  </code>
                ))}
              </div>
            )}
          </div>
        )}

        <Tabs value={tab} onValueChange={(value) => setTab(value === 'source' ? 'source' : 'capabilities')}>
          <TabsList className="flex h-auto justify-start gap-1 rounded-none border-b bg-transparent p-0" aria-label={t('extensionsPanels.capabilityReview.tabsAriaLabel')}>
            <TabsTrigger value="capabilities" className="flex items-center gap-1 rounded-none px-3 py-1.5 text-xs font-medium border-b-2 border-transparent bg-transparent shadow-none data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">
              <ShieldCheck className="h-3.5 w-3.5" />
              {t('extensionsPanels.capabilityReview.capabilitiesTab')}
            </TabsTrigger>
            <TabsTrigger value="source" className="flex items-center gap-1 rounded-none px-3 py-1.5 text-xs font-medium border-b-2 border-transparent bg-transparent shadow-none data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">
              <FileCode2 className="h-3.5 w-3.5" />
              {t('extensionsPanels.capabilityReview.sourceTab')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="source" className="mt-0">
            <BundlePreview bundle={summary.bundle} />
          </TabsContent>
          <TabsContent value="capabilities" className="mt-0">
          <ScrollArea className="max-h-72 rounded-md border">
          <ul className="divide-y">
            {rows.length === 0 && (
              <li className="px-4 py-3 text-sm text-muted-foreground">
                {t('extensionsPanels.capabilityReview.noCapabilities')}
              </li>
            )}
            {rows.map((row) => (
              <li key={row.raw} className="flex items-start gap-3 px-4 py-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={granted.has(row.raw)}
                  onChange={(e) => toggle(row.raw, e.target.checked)}
                  aria-label={t('extensionsPanels.capabilityReview.grantAriaLabel', { raw: row.raw })}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono">{row.raw}</code>
                    <RiskBadge tier={row.risk?.tier ?? 'red'} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.risk
                      ? localizeCapabilityRisk(row.risk, t)
                      : t('extensionsPanels.capabilityReview.unknownCapabilityDescription')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          </ScrollArea>

        {needsConfirm && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm">
            <div className="font-medium text-destructive flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              {t('extensionsPanels.capabilityReview.highRiskTitle')}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('extensionsPanels.capabilityReview.confirmInstruction', { phrase: APPROVE_PHRASE })}
            </p>
            {/* Confirmation appears after an explicit action and requires a typed phrase. */}
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <Input autoFocus
              className="mt-2"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={APPROVE_PHRASE}
              aria-label={t('extensionsPanels.capabilityReview.confirmAriaLabel', { phrase: APPROVE_PHRASE })}
            />
          </div>
        )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            <X className="mr-1 h-4 w-4" />
            {t('extensionsPanels.capabilityReview.cancelButton')}
          </Button>
          <Button
            disabled={!canApprove}
            onClick={() => onApprove(Array.from(granted))}
          >
            <CheckCircle2 className="mr-1 h-4 w-4" />
            {t('extensionsPanels.capabilityReview.installButton')}
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
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide',
        tier === 'red' && 'bg-destructive/20 text-destructive',
        tier === 'yellow' && 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
        tier === 'green' && 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400',
      )}
    >
      {localizeRiskTier(tier, t)}
    </span>
  );
}
