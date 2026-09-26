/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PromoteToolDialog` — turn a saved script into a persistent tool.
 *
 * Reads the script source, infers a minimal capability set via
 * `inferCapabilities`, lets the user pick a name / category / icon /
 * hotkey, then routes through `CapabilityReview` for the security
 * gate before installing.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md +
 * `09-implementation-plan.md` P1.T11 / T12.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Sparkles, X } from 'lucide-react';
import {
  inferCapabilities,
  packBundle,
  sha256Hex,
  type Bundle,
  type ExtensionManifest,
} from '@ifc-lite/extensions';
import { ICON_CHOICES } from './icon-registry';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CapabilityReview } from './CapabilityReview';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import type { ExtensionInstallSummary } from '@/services/extensions/host';
import { ExtensionInstallError } from '@/services/extensions/host';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { styleInterpolatedValues } from '@/i18n/richInterpolate';

const MODEL_READ_CAPABILITY = 'model.read';

interface PromoteToolDialogProps {
  open: boolean;
  /** The script source the user is promoting. */
  source: string;
  /** Initial label the user can edit. */
  initialName?: string;
  onClose(): void;
}

// Icon choices live in ./icon-registry — a single source of truth
// shared with ExtensionToolbarSlot so the icon the user picks here
// is the icon that lands in the menubar.

export function PromoteToolDialog({ open, source, initialName, onClose }: PromoteToolDialogProps) {
  const { t } = useTranslation();
  const host = useExtensionHost();
  const defaultName = t('extensionsPanels.promoteToolDialog.defaultName');
  const [name, setName] = useState(initialName ?? defaultName);
  const nameEditedRef = useRef(false);
  const [hotkey, setHotkey] = useState('');
  const [icon, setIcon] = useState<string>('sparkles');
  const [pending, setPending] = useState<{ bytes: Uint8Array; summary: ExtensionInstallSummary } | null>(null);
  const [busy, setBusy] = useState(false);

  const inference = useMemo(() => inferCapabilities(source), [source]);

  useEffect(() => {
    if (!open) {
      nameEditedRef.current = false;
      return;
    }
    if (!nameEditedRef.current) {
      setName(initialName ?? defaultName);
    }
  }, [defaultName, initialName, open]);

  const handlePromote = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { bytes, summary } = await synthesiseBundle({
        name,
        source,
        hotkey,
        icon,
        capabilities: inference.capabilities,
      });
      setPending({ bytes, summary });
    } catch (err) {
      toast.error(t('extensionsPanels.promoteToolDialog.packageFailedToast', {
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async (grants: string[]) => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const status = await host.installFromBytes(pending.bytes, grants);
      // Point the user at the payoff — the actual button. The
      // synthesised manifest puts the command on `toolbar.right`,
      // so it shows up as an icon button at the top-right of the
      // toolbar. Mention the hotkey too if they set one.
      const message = hotkey.trim()
        ? t('extensionsPanels.promoteToolDialog.installedWithHotkey', { name, hotkey: hotkey.trim() })
        : t('extensionsPanels.promoteToolDialog.installedNoHotkey', { name });
      toast.success(message);
      setPending(null);
      onClose();
      void status;
    } catch (err) {
      if (err instanceof ExtensionInstallError) {
        toast.error(t('extensionsPanels.promoteToolDialog.installRejectedToast', {
          message: err.validationErrors[0]?.message ?? err.message,
        }));
      } else {
        toast.error(t('extensionsPanels.promoteToolDialog.installFailedToast', {
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    } finally {
      setBusy(false);
    }
  };

  if (pending) {
    return (
      <CapabilityReview
        open
        summary={pending.summary}
        onApprove={handleApprove}
        onCancel={() => setPending(null)}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <DialogTitle>{t('extensionsPanels.promoteToolDialog.title')}</DialogTitle>
          </div>
          <DialogDescription>
            {t('extensionsPanels.promoteToolDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tool-name">{t('extensionsPanels.promoteToolDialog.nameLabel')}</Label>
            <Input
              id="tool-name"
              value={name}
              onChange={(e) => {
                nameEditedRef.current = true;
                setName(e.target.value);
              }}
              placeholder={t('extensionsPanels.promoteToolDialog.namePlaceholder')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tool-hotkey">{t('extensionsPanels.promoteToolDialog.hotkeyLabel')}</Label>
            <Input
              id="tool-hotkey"
              value={hotkey}
              onChange={(e) => setHotkey(e.target.value)}
              placeholder={t('extensionsPanels.promoteToolDialog.hotkeyPlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('extensionsPanels.promoteToolDialog.iconLabel')}</Label>
            <div
              role="radiogroup"
              aria-label={t('extensionsPanels.promoteToolDialog.iconGroupAriaLabel')}
              className="grid grid-cols-10 gap-1.5 p-2 rounded-md border bg-muted/40"
            >
              {ICON_CHOICES.map(({ key, Icon, label }) => {
                const selected = icon === key;
                return (
                  // Icon choices are styled buttons with one-of-many radio semantics.
                  // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
                  <button type="button" role="radio"
                    key={key}
                    aria-checked={selected}
                    aria-label={label}
                    title={label}
                    onClick={() => setIcon(key)}
                    className={cn(
                      'flex items-center justify-center h-8 w-8 rounded border transition-colors',
                      selected
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-md border bg-muted/40 p-3">
            <div className="text-xs font-semibold mb-2">{t('extensionsPanels.promoteToolDialog.inferredCapabilitiesHeading')}</div>
            {inference.capabilities.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                {styleInterpolatedValues(t, 'extensionsPanels.promoteToolDialog.noCapabilitiesDetected', [
                  ['capability', <code key="capability" className="font-mono">{MODEL_READ_CAPABILITY}</code>],
                ])}
              </div>
            ) : (
              <ul className="space-y-1">
                {inference.capabilities.map((cap) => (
                  <li key={cap} className="text-xs flex items-center gap-2">
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    <code className="font-mono">{cap}</code>
                  </li>
                ))}
              </ul>
            )}
            {inference.observations.some((o) => o.unknown) && (
              <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                {t('extensionsPanels.promoteToolDialog.unknownCallsWarning')}
              </div>
            )}
            {inference.parseErrors.length > 0 && (
              <div className="mt-2 text-xs text-destructive">
                {t('extensionsPanels.promoteToolDialog.parseErrorWarning')}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            <X className="mr-1 h-4 w-4" />
            {t('extensionsPanels.promoteToolDialog.cancelButton')}
          </Button>
          <Button onClick={handlePromote} disabled={busy || name.trim().length === 0}>
            <Sparkles className="mr-1 h-4 w-4" />
            {t('extensionsPanels.promoteToolDialog.reviewInstallButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SynthArgs {
  name: string;
  source: string;
  hotkey: string;
  icon: string;
  capabilities: string[];
}

async function synthesiseBundle(
  args: SynthArgs,
): Promise<{ bytes: Uint8Array; summary: ExtensionInstallSummary }> {
  const slug = slugFromName(args.name);
  const id = `com.local.tools.${slug}`;
  const commandId = `${id}.run`;
  const caps = args.capabilities.length > 0 ? args.capabilities : [MODEL_READ_CAPABILITY];
  // Engine range MUST match the running SDK or the loader skips the
  // bundle on install — the tool then never appears as a toolbar
  // button. Pin to ">=<currentSdk>" using the live app version
  // instead of a hardcoded guess.
  const sdkVersion =
    typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0
      ? __APP_VERSION__
      : '1.0.0';
  const manifest: ExtensionManifest = {
    manifestVersion: 1,
    id,
    name: args.name,
    description: `Promoted from a saved script.`,
    version: '0.1.0',
    engines: { ifcLiteSdk: `>=${sdkVersion}` },
    capabilities: caps,
    activation: [`onCommand:${commandId}`],
    contributes: {
      commands: [{ id: commandId, title: args.name, icon: args.icon }],
      toolbar: [{ command: commandId, slot: 'toolbar.right' }],
      ...(args.hotkey
        ? { keybindings: [{ command: commandId, key: args.hotkey.trim() }] }
        : {}),
    },
    entry: { commands: { [commandId]: 'src/commands/run.js' } },
  };
  const handler = wrapScriptAsCommand(args.source);
  const files = new Map<string, { path: string; bytes: Uint8Array; text?: string }>();
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  files.set('manifest.json', { path: 'manifest.json', bytes: new TextEncoder().encode(manifestText), text: manifestText });
  files.set('src/commands/run.js', { path: 'src/commands/run.js', bytes: new TextEncoder().encode(handler), text: handler });
  const bundle: Bundle = { manifest, files, source: { kind: 'memory' } };
  const bytes = packBundle(bundle);
  const hash = await sha256Hex(bytes);
  return {
    bytes,
    summary: { id, version: '0.1.0', bundleHash: hash, capabilities: caps, bundle, signed: false },
  };
}

function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || `tool-${Math.random().toString(36).slice(2, 8)}`;
}

function wrapScriptAsCommand(source: string): string {
  // `run` is intentionally NOT async. The bim.* SDK is fully
  // synchronous, and a promoted script is plain top-level code. An
  // `async` wrapper would return a pending promise whose body only
  // runs once the QuickJS job queue is drained — so the tool would
  // silently do nothing (0 logs, instant "success"). A sync function
  // runs to completion inside evalCode, exactly like the one-shot.
  return `/* Promoted from a saved script. */
function run(ctx) {
  const bim = ctx.bim;
${source.trim().split('\n').map((line) => `  ${line}`).join('\n')}
}
`;
}
