/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RepairQueuePanel` — surface SDK-update revalidation results.
 *
 * Runs `ExtensionHostService.revalidateForSdk(currentSdk)` on mount,
 * lists each extension with compatibility status + test outcome, and
 * lets the user trigger an AI-assisted repair for items in the
 * `needsRepair` bucket. Repair routing seeds the chat with a fix
 * prompt; the chat panel then drives the regular authoring loop.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §5.
 */

import { useCallback, useState } from 'react';
import { CheckCircle2, RefreshCcw, ShieldAlert, Wrench, X } from 'lucide-react';
import { needsSdkRepair } from '@ifc-lite/extensions';
import type {
  CompatibilityResult,
  RevalidationItem,
  RevalidationSummary,
} from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { useTranslation, type UseTranslationResult } from '@/i18n';
import { HelpHint } from './HelpHint';
import { styleInterpolatedValues } from '@/i18n/richInterpolate';
import { formatLocaleNumber } from '@/i18n/intlFormat';

const ENGINE_RANGE_CODE = 'engines.ifcLiteSdk';
const APP_VERSION_CODE = '__APP_VERSION__';

interface RepairQueuePanelProps {
  /** SDK version to revalidate against. Defaults to APP_VERSION. */
  sdkVersion?: string;
  onClose?: () => void;
}

export function RepairQueuePanel({ sdkVersion, onClose }: RepairQueuePanelProps) {
  const { t, locale } = useTranslation();
  const host = useExtensionHost();
  const queueChatPrompt = useViewerStore((s) => s.queueChatPrompt);
  const setChatPanelVisible = useViewerStore((s) => s.setChatPanelVisible);
  const setScriptPanelVisible = useViewerStore((s) => s.setScriptPanelVisible);
  const [summary, setSummary] = useState<RevalidationSummary | undefined>();
  const [busy, setBusy] = useState(false);
  // SDK version comes from the Vite-injected __APP_VERSION__ define.
  // We deliberately do NOT fall back to '0.0.0' on miss — a fake low
  // version would flag every range as outdated and produce a wave of
  // false-positive repair prompts.
  const version =
    sdkVersion
    ?? (typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0 ? __APP_VERSION__ : undefined);

  const run = useCallback(async () => {
    if (!version) return;
    setBusy(true);
    try {
      const next = await host.revalidateForSdk(version);
      setSummary(next);
    } catch (err) {
      toast.error(t('extensionsPanels.repairQueuePanel.revalidationFailedToast', {
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusy(false);
    }
  }, [host, version, t]);

  // Eager-run is gated behind an explicit user click. Mounting alone
  // shouldn't spin up sandboxes for every installed extension — that
  // can be expensive when many extensions are installed and outdated.

  const repairItem = (item: RevalidationItem) => {
    if (!version) return;
    queueChatPrompt(buildRepairPrompt(item, version));
    setChatPanelVisible(true);
    setScriptPanelVisible(true);
    toast.success(t('extensionsPanels.repairQueuePanel.routingRepairToast', { extensionId: item.extensionId }));
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4" />
          <h2 className="text-sm font-semibold">{t('extensionsPanels.repairQueuePanel.title')}</h2>
          {summary && (
            <span className="text-2xs text-muted-foreground">
              {t('extensionsPanels.repairQueuePanel.summaryLine', {
                sdk: summary.sdk,
                count: summary.needsRepair.length,
                countDisplay: formatLocaleNumber(locale, summary.needsRepair.length),
              })}
            </span>
          )}
          <HelpHint label={t('extensionsPanels.repairQueuePanel.helpLabel')}>
            <p>
              {styleInterpolatedValues(t, 'extensionsPanels.repairQueuePanel.helpIntro', [
                ['engineRange', <code key="engine-range">{ENGINE_RANGE_CODE}</code>],
              ])}
            </p>
            <p>
              {styleInterpolatedValues(t, 'extensionsPanels.repairQueuePanel.helpActions', [
                ['runCheck', <strong key="run-check">{t('extensionsPanels.repairQueuePanel.runCheckLabel')}</strong>],
                ['repair', <strong key="repair">{t('extensionsPanels.repairQueuePanel.repairLabel')}</strong>],
              ])}
            </p>
            <p>
              {t('extensionsPanels.repairQueuePanel.helpNoAuto')}
            </p>
          </HelpHint>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => void run()} disabled={busy || !version}>
            <RefreshCcw className="mr-1 h-3.5 w-3.5" />
            {t('extensionsPanels.repairQueuePanel.rerunButton')}
          </Button>
          {onClose && (
            <IconButton label={t('extensionsPanels.repairQueuePanel.closeAriaLabel')} onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        {!version ? (
          <div className="px-6 py-12 text-center text-sm text-rose-600 dark:text-rose-400">
            {styleInterpolatedValues(t, 'extensionsPanels.repairQueuePanel.sdkUnknown', [
              ['appVersion', <code key="app-version" className="font-mono">{APP_VERSION_CODE}</code>],
            ])}
          </div>
        ) : !summary ? (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground space-y-3">
            <div>{t('extensionsPanels.repairQueuePanel.noCheckRun')}</div>
            <Button size="sm" variant="outline" onClick={() => void run()} disabled={busy}>
              <RefreshCcw className="mr-1 h-3.5 w-3.5" />
              {t('extensionsPanels.repairQueuePanel.runCheckLabel')}
            </Button>
          </div>
        ) : summary.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <div className="text-sm font-medium">{t('extensionsPanels.repairQueuePanel.noInstalledExtensions')}</div>
          </div>
        ) : (
          <ul className="divide-y">
            {summary.items.map((item) => (
              <RepairRow key={item.extensionId} item={item} onRepair={() => repairItem(item)} />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function RepairRow({
  item,
  onRepair,
}: {
  item: RevalidationItem;
  onRepair: () => void;
}) {
  const { t, locale } = useTranslation();
  const tone =
    item.outcome === 'pass'
      ? 'text-emerald-600 dark:text-emerald-400'
      : item.outcome === 'skipped'
        ? 'text-muted-foreground'
        : 'text-rose-600 dark:text-rose-400';
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {item.outcome === 'pass' ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <ShieldAlert className={`h-3.5 w-3.5 ${tone}`} />
            )}
            <code className="text-xs font-mono break-all">{item.extensionId}</code>
            <span className={`text-2xs uppercase tracking-wide font-semibold ${tone}`}>
              {localizeRevalidationOutcome(item.outcome, t)}
            </span>
          </div>
          <div className="mt-1 text-2xs text-muted-foreground">
            {t('extensionsPanels.repairQueuePanel.rangeLabel', {
              range: item.compatibility.declared,
              reason: localizeCompatibilityReason(item.compatibility, t),
            })}
          </div>
          {item.tests && item.tests.failed > 0 && (
            <div className="mt-1 text-2xs text-rose-600 dark:text-rose-400">
              {t('extensionsPanels.repairQueuePanel.testsFailed', {
                count: item.tests.failed,
                countDisplay: formatLocaleNumber(locale, item.tests.failed),
                error: item.tests.results.find((r) => !r.passed)?.error ?? '',
              })}
            </div>
          )}
        </div>
        {needsSdkRepair(item) && (
          <Button size="sm" variant="outline" onClick={onRepair}>
            <Wrench className="mr-1 h-3.5 w-3.5" />
            {t('extensionsPanels.repairQueuePanel.repairLabel')}
          </Button>
        )}
      </div>
    </li>
  );
}

function localizeRevalidationOutcome(
  outcome: RevalidationItem['outcome'],
  t: UseTranslationResult['t'],
): string {
  switch (outcome) {
    case 'pass':
      return t('extensionsPanels.repairQueuePanel.outcome.pass');
    case 'fail':
      return t('extensionsPanels.repairQueuePanel.outcome.fail');
    case 'skipped':
      return t('extensionsPanels.repairQueuePanel.outcome.skipped');
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

function localizeCompatibilityReason(
  compatibility: CompatibilityResult,
  t: UseTranslationResult['t'],
): string {
  switch (compatibility.reasonCode) {
    case 'invalid-sdk-version':
      return t('extensionsPanels.repairQueuePanel.compatibility.invalidSdkVersion', {
        sdk: compatibility.sdk,
      });
    case 'unsupported-range':
      return t('extensionsPanels.repairQueuePanel.compatibility.unsupportedRange');
    case 'range-mismatch':
      return t('extensionsPanels.repairQueuePanel.compatibility.rangeMismatch', {
        declared: compatibility.declared,
        sdk: compatibility.sdk,
      });
    case 'range-match':
      return t('extensionsPanels.repairQueuePanel.compatibility.rangeMatch', {
        declared: compatibility.declared,
        sdk: compatibility.sdk,
      });
    default: {
      const exhaustive: never = compatibility.reasonCode;
      return exhaustive;
    }
  }
}

function buildRepairPrompt(item: RevalidationItem, sdk: string): string {
  const failures = item.tests?.results.filter((r) => !r.passed) ?? [];
  return [
    `Repair extension ${item.extensionId} for SDK ${sdk}.`,
    '',
    `The declared engine range was \`${item.compatibility.declared}\` (status: ${item.compatibility.status}).`,
    '',
    failures.length > 0
      ? `${failures.length} test${failures.length === 1 ? '' : 's'} failed under the new SDK:`
      : 'No failing tests were captured; revalidation flagged compatibility only.',
    ...failures.map((f) => `- ${f.name}: ${f.error ?? 'unknown'}`),
    '',
    'Update the bundle so tests pass against the new SDK while keeping the same user-visible behaviour. Bump engines.ifcLiteSdk as appropriate.',
  ].join('\n');
}
