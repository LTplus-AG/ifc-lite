/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PrivacyPanel` — local privacy controls.
 *
 * Surfaces the no-content rule from RFC §06 §7 in prose, plus three
 * actions the user can take any time:
 *
 *   - Export the action log as a JSON file (data they can audit).
 *   - Clear the action log.
 *   - Edit the prompt overlay (their personal notes the assistant
 *     sees alongside the system prompt).
 *
 * Everything here is local. Nothing here triggers a network call.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §7.
 */

import { useEffect, useState } from 'react';
import { Brain, Download, Eraser, ScrollText, Save, Shield, X } from 'lucide-react';
import {
  clampOverlay,
  extractMemoryProposals,
  mergeIntoOverlay,
  type Flavor,
  type MemoryProposal,
  type TranscriptTurn,
} from '@ifc-lite/extensions';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { toast } from '@/components/ui/toast';
import { HelpHint } from './HelpHint';

interface PrivacyPanelProps {
  onClose?: () => void;
}

export function PrivacyPanel({ onClose }: PrivacyPanelProps) {
  const host = useExtensionHost();
  const [logSize, setLogSize] = useState({ events: 0, bytes: 0 });
  const [activeFlavor, setActiveFlavor] = useState<Flavor | undefined>();
  const [overlayDraft, setOverlayDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const chatMessages = useViewerStore((s) => s.chatMessages);

  const refresh = async () => {
    try {
      setLogSize({ events: host.actionLog.size(), bytes: host.actionLog.byteSize() });
      const flavor = await host.flavors.getActive();
      setActiveFlavor(flavor);
      if (flavor && !dirty) {
        setOverlayDraft(flavor.promptOverlay?.content ?? '');
      }
    } catch (err) {
      console.warn('[PrivacyPanel] refresh failed:', err);
    }
  };

  useEffect(() => {
    void refresh();
    const offFlavor = host.flavors.onChange(() => void refresh());
    const offLog = host.actionLog.subscribe(() => {
      setLogSize({ events: host.actionLog.size(), bytes: host.actionLog.byteSize() });
    });
    return () => {
      offFlavor();
      offLog();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const handleExportLog = () => {
    const json = host.actionLog.exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ifclite-action-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Action log exported.');
  };

  const handleClearLog = () => {
    if (!confirm('Clear the local action log? Suggestions reset until you build up new patterns.')) return;
    host.actionLog.clear();
    // Wipe the IDB mirror too — otherwise reload would resurrect the
    // events the user just asked to forget.
    void host.clearPersistedActionLog().catch((err) => {
      console.warn('[PrivacyPanel] clear persisted action log failed:', err);
    });
    setLogSize({ events: 0, bytes: 0 });
    toast.success('Action log cleared.');
  };

  const handleExtractMemory = () => {
    const transcript: TranscriptTurn[] = chatMessages.map((m) => ({
      role: m.role === 'system' ? 'system' : (m.role as 'user' | 'assistant'),
      content: m.content,
    }));
    const next = extractMemoryProposals(transcript);
    setProposals(next);
    if (next.length === 0) {
      toast.info('No stable preferences detected in this session yet.');
    } else {
      toast.success(`Found ${next.length} candidate preference${next.length === 1 ? '' : 's'}.`);
    }
  };

  const handleAcceptProposals = () => {
    const next = mergeIntoOverlay(overlayDraft, proposals);
    setOverlayDraft(next);
    setDirty(true);
    setProposals([]);
    toast.success(`Added ${proposals.length} preference${proposals.length === 1 ? '' : 's'} to the overlay. Save to keep them.`);
  };

  const handleSaveOverlay = async () => {
    if (!activeFlavor) {
      toast.error('No active flavor — switch to one before editing its overlay.');
      return;
    }
    setBusy(true);
    try {
      const clamped = clampOverlay(overlayDraft, { maxTokens: 4000 });
      await host.flavors.put(
        { ...activeFlavor, promptOverlay: clamped.overlay },
        'overlay edit',
      );
      setOverlayDraft(clamped.overlay.content);
      setDirty(false);
      if (clamped.truncated) {
        toast.info(`Overlay clamped to ~${clamped.estimatedTokens} tokens.`);
      } else {
        toast.success(`Overlay saved (${clamped.estimatedTokens} tokens).`);
      }
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4" />
          <h2 className="text-sm font-semibold">Privacy</h2>
          <HelpHint label="Privacy">
            <p>
              IFClite keeps a <strong>content-free action log</strong>{' '}
              of intents you perform (model loads, lens applies,
              exports) — used by the pattern miner to suggest one-click
              tools. The log never records model content, chat content,
              file names, or API keys.
            </p>
            <p>
              The <strong>prompt overlay</strong> on the active flavor
              is appended to every chat system prompt — use it for
              stable preferences. <strong>Extract from chat</strong>{' '}
              scans the current session for explicit preferences and
              proposes them.
            </p>
          </HelpHint>
        </div>
        {onClose && (
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="px-4 py-3 space-y-4 text-xs">
          <section className="space-y-1.5">
            <h3 className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">
              What we store locally
            </h3>
            <p className="text-muted-foreground leading-relaxed">
              ifc-lite keeps a content-free <strong>action log</strong> of the
              high-level intents you perform (model loads, lens applies,
              exports). We use it to mine recurring patterns and surface
              one-click tool suggestions. The log never records model
              content, chat content, file names, or API keys.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              Suggestions, the audit log, the prompt overlay, and your
              flavor library are all stored in your browser's IndexedDB —
              nothing here is sent off device unless you explicitly export.
            </p>
          </section>

          <section className="space-y-1.5">
            <h3 className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">
              Action log
            </h3>
            <div className="rounded border bg-muted/30 px-3 py-2">
              <div>
                {logSize.events} events · {(logSize.bytes / 1024).toFixed(1)} KiB
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" onClick={handleExportLog} disabled={logSize.events === 0}>
                  <Download className="mr-1 h-3.5 w-3.5" />
                  Export JSON
                </Button>
                <Button size="sm" variant="outline" onClick={handleClearLog} disabled={logSize.events === 0}>
                  <Eraser className="mr-1 h-3.5 w-3.5" />
                  Clear
                </Button>
              </div>
            </div>
          </section>

          <section className="space-y-1.5">
            <h3 className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">
              Prompt overlay
            </h3>
            <p className="text-muted-foreground">
              Notes appended to the AI assistant's system prompt for the
              active flavor. Use it for stable preferences ("write CSV
              exports with semicolons", "default to red color for IfcWall").
              Capped at ~4000 tokens.
            </p>
            {!activeFlavor ? (
              <div className="rounded border bg-muted/30 px-3 py-2 text-muted-foreground italic">
                No active flavor. Activate or import one to attach overlay
                notes to it.
              </div>
            ) : (
              <>
                <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <ScrollText className="h-3 w-3" />
                  Editing overlay for{' '}
                  <span className="font-medium text-foreground">{activeFlavor.name}</span>
                </div>
                <textarea
                  className="w-full min-h-[160px] rounded border bg-background p-2 font-mono text-[11px] leading-relaxed"
                  value={overlayDraft}
                  onChange={(e) => {
                    setOverlayDraft(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="e.g. Always export CSV with semicolon separators. Default lens for IfcWall: by-fire-rating."
                />
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[10px] text-muted-foreground">
                    {Math.ceil(overlayDraft.length / 4)} approx tokens
                  </span>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="outline" onClick={handleExtractMemory} disabled={chatMessages.length === 0}>
                      <Brain className="mr-1 h-3.5 w-3.5" />
                      Extract from chat
                    </Button>
                    <Button size="sm" onClick={() => void handleSaveOverlay()} disabled={busy || !dirty}>
                      <Save className="mr-1 h-3.5 w-3.5" />
                      Save overlay
                    </Button>
                  </div>
                </div>

                {proposals.length > 0 && (
                  <div className="rounded border bg-muted/30 px-3 py-2 space-y-2">
                    <div className="text-[11px] font-medium">
                      {proposals.length} candidate preference{proposals.length === 1 ? '' : 's'}
                    </div>
                    <div className="text-[10px] text-amber-700 dark:text-amber-400 italic">
                      Rule-based scan — review each line before saving.
                      The extractor uses a heuristic blocklist; it is not
                      a guarantee that no content slips through.
                    </div>
                    <ul className="space-y-1 text-[11px]">
                      {proposals.map((p, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="text-muted-foreground">·</span>
                          <span className="flex-1">{p.phrasing}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {Math.round(p.confidence * 100)}%
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setProposals([])}>
                        Discard
                      </Button>
                      <Button size="sm" onClick={handleAcceptProposals}>
                        Add to overlay
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
