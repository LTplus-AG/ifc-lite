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
import type { RevalidationItem, RevalidationSummary } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { HelpHint } from './HelpHint';

interface RepairQueuePanelProps {
  /** SDK version to revalidate against. Defaults to APP_VERSION. */
  sdkVersion?: string;
  onClose?: () => void;
}

export function RepairQueuePanel({ sdkVersion, onClose }: RepairQueuePanelProps) {
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
      toast.error(`Revalidation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [host, version]);

  // Eager-run is gated behind an explicit user click. Mounting alone
  // shouldn't spin up sandboxes for every installed extension — that
  // can be expensive when many extensions are installed and outdated.

  const repairItem = (item: RevalidationItem) => {
    if (!version) return;
    queueChatPrompt(buildRepairPrompt(item, version));
    setChatPanelVisible(true);
    setScriptPanelVisible(true);
    toast.success(`Routing repair for ${item.extensionId}…`);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4" />
          <h2 className="text-sm font-semibold">Repair queue</h2>
          {summary && (
            <span className="text-[11px] text-muted-foreground">
              SDK {summary.sdk} · {summary.needsRepair.length} need fixing
            </span>
          )}
          <HelpHint label="Repair queue">
            <p>
              When the viewer SDK bumps, extensions whose declared
              <code> engines.ifcLiteSdk</code> range no longer matches
              are flagged here.
            </p>
            <p>
              <strong>Run check</strong> spins up a sandbox for each
              outdated extension and runs its manifest tests against
              the new SDK. Failing tests get a <strong>Repair</strong>
              button that seeds chat with a fix prompt — the AI
              authoring loop produces the patched bundle.
            </p>
            <p>
              Doesn't run automatically (each check spawns sandboxes).
            </p>
          </HelpHint>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => void run()} disabled={busy || !version}>
            <RefreshCcw className="mr-1 h-3.5 w-3.5" />
            Re-run
          </Button>
          {onClose && (
            <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close">
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        {!version ? (
          <div className="px-6 py-12 text-center text-sm text-rose-600 dark:text-rose-400">
            SDK version unknown — cannot revalidate. Set <code className="font-mono">__APP_VERSION__</code> via Vite define.
          </div>
        ) : !summary ? (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground space-y-3">
            <div>No compatibility check has run for this session.</div>
            <Button size="sm" variant="outline" onClick={() => void run()} disabled={busy}>
              <RefreshCcw className="mr-1 h-3.5 w-3.5" />
              Run check
            </Button>
          </div>
        ) : summary.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <div className="text-sm font-medium">No installed extensions</div>
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
            <span className={`text-[10px] uppercase tracking-wide font-semibold ${tone}`}>
              {item.outcome}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Range <code className="font-mono">{item.compatibility.declared}</code> · {item.compatibility.reason}
          </div>
          {item.tests && item.tests.failed > 0 && (
            <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
              {item.tests.failed} test{item.tests.failed === 1 ? '' : 's'} failed:
              {' '}
              {item.tests.results.find((r) => !r.passed)?.error}
            </div>
          )}
        </div>
        {itemNeedsRepair(item) && (
          <Button size="sm" variant="outline" onClick={onRepair}>
            <Wrench className="mr-1 h-3.5 w-3.5" />
            Repair
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Whether a row should show a Repair button. Mirrors the
 * `needsRepair` filter in `revalidateAgainstSdk` exactly — a failed
 * test OR a skipped extension whose declared range is outdated — so
 * the header count and the actionable rows never disagree.
 */
function itemNeedsRepair(item: RevalidationItem): boolean {
  return (
    item.outcome === 'fail'
    || (item.outcome === 'skipped' && item.compatibility.status === 'outdated')
  );
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
