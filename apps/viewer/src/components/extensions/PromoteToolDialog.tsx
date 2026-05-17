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

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Beaker,
  Box,
  Brain,
  Calculator,
  Camera,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Download,
  Eye,
  FileBarChart,
  FileText,
  Filter,
  Flame,
  Gauge,
  Hammer,
  Layers,
  Lightbulb,
  Maximize2,
  Palette,
  Ruler,
  ScanSearch,
  Scissors,
  Settings,
  Shield,
  Sparkles,
  Tag,
  Target,
  Wrench,
  X,
} from 'lucide-react';
import {
  inferCapabilities,
  packBundle,
  sha256Hex,
  type Bundle,
  type ExtensionManifest,
} from '@ifc-lite/extensions';
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

interface PromoteToolDialogProps {
  open: boolean;
  /** The script source the user is promoting. */
  source: string;
  /** Initial label the user can edit. */
  initialName?: string;
  onClose(): void;
}

/**
 * Curated lucide icon set for the picker. Limited to a small,
 * semantically-distinct subset (~24) so the user can find one fast.
 * Keys match lucide icon names — the runtime renders them via the
 * imported component, manifests record the string key for portability.
 */
const ICON_CHOICES: { key: string; Icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { key: 'sparkles', Icon: Sparkles, label: 'AI / magic' },
  { key: 'wrench', Icon: Wrench, label: 'Tool' },
  { key: 'hammer', Icon: Hammer, label: 'Build' },
  { key: 'palette', Icon: Palette, label: 'Color' },
  { key: 'eye', Icon: Eye, label: 'View' },
  { key: 'filter', Icon: Filter, label: 'Filter' },
  { key: 'shield', Icon: Shield, label: 'Compliance' },
  { key: 'flame', Icon: Flame, label: 'Fire rating' },
  { key: 'ruler', Icon: Ruler, label: 'Measure' },
  { key: 'calculator', Icon: Calculator, label: 'Quantity' },
  { key: 'box', Icon: Box, label: 'Element' },
  { key: 'layers', Icon: Layers, label: 'Storey' },
  { key: 'tag', Icon: Tag, label: 'Classification' },
  { key: 'target', Icon: Target, label: 'Isolate' },
  { key: 'scan-search', Icon: ScanSearch, label: 'Audit' },
  { key: 'clipboard-list', Icon: ClipboardList, label: 'Schedule' },
  { key: 'file-text', Icon: FileText, label: 'Report' },
  { key: 'file-bar-chart', Icon: FileBarChart, label: 'Chart' },
  { key: 'download', Icon: Download, label: 'Export' },
  { key: 'camera', Icon: Camera, label: 'Snapshot' },
  { key: 'scissors', Icon: Scissors, label: 'Section' },
  { key: 'maximize-2', Icon: Maximize2, label: 'Fly to' },
  { key: 'gauge', Icon: Gauge, label: 'Performance' },
  { key: 'lightbulb', Icon: Lightbulb, label: 'Idea' },
  { key: 'alert-triangle', Icon: AlertTriangle, label: 'Warning' },
  { key: 'beaker', Icon: Beaker, label: 'Test' },
  { key: 'brain', Icon: Brain, label: 'Memory' },
  { key: 'check-circle-2', Icon: CheckCircle2, label: 'Validate' },
  { key: 'settings', Icon: Settings, label: 'Setting' },
];

export function PromoteToolDialog({ open, source, initialName, onClose }: PromoteToolDialogProps) {
  const host = useExtensionHost();
  const [name, setName] = useState(initialName ?? 'My tool');
  const [hotkey, setHotkey] = useState('');
  const [icon, setIcon] = useState<string>('sparkles');
  const [pending, setPending] = useState<{ bytes: Uint8Array; summary: ExtensionInstallSummary } | null>(null);
  const [busy, setBusy] = useState(false);

  const inference = useMemo(() => inferCapabilities(source), [source]);

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
      toast.error(`Failed to package tool: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async (grants: string[]) => {
    if (!pending) return;
    try {
      const status = await host.installFromBytes(pending.bytes, grants);
      toast.success(`Installed "${name}" — find it in the command palette.`);
      setPending(null);
      onClose();
      void status;
    } catch (err) {
      if (err instanceof ExtensionInstallError) {
        toast.error(`Install rejected: ${err.validationErrors[0]?.message ?? err.message}`);
      } else {
        toast.error(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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
            <DialogTitle>Promote script to a tool</DialogTitle>
          </div>
          <DialogDescription>
            Turn this saved script into a persistent, sandboxed tool. The tool
            appears in the command palette and on the toolbar. It runs in the
            same sandbox as your scripts with only the capabilities you grant.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tool-name">Name</Label>
            <Input
              id="tool-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Fire-rating report"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tool-hotkey">Hotkey (optional)</Label>
            <Input
              id="tool-hotkey"
              value={hotkey}
              onChange={(e) => setHotkey(e.target.value)}
              placeholder="Ctrl+Alt+F"
            />
          </div>

          <div className="space-y-2">
            <Label>Icon</Label>
            <div
              role="radiogroup"
              aria-label="Pick a toolbar icon"
              className="grid grid-cols-10 gap-1.5 p-2 rounded-md border bg-muted/40"
            >
              {ICON_CHOICES.map(({ key, Icon, label }) => {
                const selected = icon === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
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
            <div className="text-xs font-semibold mb-2">Inferred capabilities</div>
            {inference.capabilities.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                No `bim.*` calls detected. The tool will request only
                <code className="font-mono ml-1">model.read</code>.
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
              <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                Unknown `bim.*` calls detected — review the source before approving.
              </div>
            )}
            {inference.parseErrors.length > 0 && (
              <div className="mt-2 text-[11px] text-destructive">
                Script does not parse cleanly — promotion may fail.
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            <X className="mr-1 h-4 w-4" />
            Cancel
          </Button>
          <Button onClick={handlePromote} disabled={busy || name.trim().length === 0}>
            <Sparkles className="mr-1 h-4 w-4" />
            Review & install
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
  const caps = args.capabilities.length > 0 ? args.capabilities : ['model.read'];
  const manifest: ExtensionManifest = {
    manifestVersion: 1,
    id,
    name: args.name,
    description: `Promoted from a saved script.`,
    version: '0.1.0',
    engines: { ifcLiteSdk: '>=2.0.0' },
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
    summary: { id, version: '0.1.0', bundleHash: hash, capabilities: caps, bundle },
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
  return `/* Promoted from a saved script. */
async function run(ctx) {
  const bim = ctx.bim;
${source.trim().split('\n').map((line) => `  ${line}`).join('\n')}
}
`;
}
