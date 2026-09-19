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

import { useEffect, useRef, useState } from 'react';
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
import { downloadFile } from '@/lib/export/download';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { HelpHint } from './HelpHint';

interface PrivacyPanelProps {
  onClose?: () => void;
}

export function PrivacyPanel({ onClose }: PrivacyPanelProps) {
  const { t } = useTranslation();
  const host = useExtensionHost();
  const [logSize, setLogSize] = useState({ events: 0, bytes: 0 });
  const [activeFlavor, setActiveFlavor] = useState<Flavor | undefined>();
  const [overlayDraft, setOverlayDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const chatMessages = useViewerStore((s) => s.chatMessages);
  // `refresh` is captured once by the long-lived `flavors.onChange`
  // listener, so it must read `dirty` through a ref — a closed-over
  // `dirty` would freeze at `false` and clobber the user's edits when
  // a later flavor change fires.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const refresh = async () => {
    try {
      setLogSize({ events: host.actionLog.size(), bytes: host.actionLog.byteSize() });
      const flavor = await host.flavors.getActive();
      setActiveFlavor(flavor);
      if (flavor && !dirtyRef.current) {
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
    downloadFile(json, `ifclite-action-log-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    toast.success(t('extensionsPanels.privacyPanel.exportLogToast'));
  };

  const handleClearLog = () => {
    if (!confirm(t('extensionsPanels.privacyPanel.clearLogConfirm'))) return;
    host.actionLog.clear();
    // Wipe the IDB mirror too — otherwise reload would resurrect the
    // events the user just asked to forget.
    void host.clearPersistedActionLog().catch((err) => {
      console.warn('[PrivacyPanel] clear persisted action log failed:', err);
    });
    setLogSize({ events: 0, bytes: 0 });
    toast.success(t('extensionsPanels.privacyPanel.clearLogToast'));
  };

  const handleExtractMemory = () => {
    const transcript: TranscriptTurn[] = chatMessages.map((m) => ({
      role: m.role === 'system' ? 'system' : (m.role as 'user' | 'assistant'),
      content: m.content,
    }));
    const next = extractMemoryProposals(transcript);
    setProposals(next);
    if (next.length === 0) {
      toast.info(t('extensionsPanels.privacyPanel.noPreferencesToast'));
    } else {
      toast.success(t('extensionsPanels.privacyPanel.foundPreferencesToast', { count: next.length }));
    }
  };

  const handleAcceptProposals = () => {
    const next = mergeIntoOverlay(overlayDraft, proposals);
    setOverlayDraft(next);
    setDirty(true);
    setProposals([]);
    toast.success(t('extensionsPanels.privacyPanel.addedPreferencesToast', { count: proposals.length }));
  };

  const handleSaveOverlay = async () => {
    if (!activeFlavor) {
      toast.error(t('extensionsPanels.privacyPanel.noActiveFlavorError'));
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
        toast.info(t('extensionsPanels.privacyPanel.overlayClampedToast', { tokens: clamped.estimatedTokens }));
      } else {
        toast.success(t('extensionsPanels.privacyPanel.overlaySavedToast', { tokens: clamped.estimatedTokens }));
      }
    } catch (err) {
      toast.error(t('extensionsPanels.privacyPanel.saveFailedToast', {
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4" />
          <h2 className="text-sm font-semibold">{t('extensionsPanels.privacyPanel.title')}</h2>
          <HelpHint label={t('extensionsPanels.privacyPanel.helpLabel')}>
            <p>
              {t('extensionsPanels.privacyPanel.helpIntroPrefix')}{' '}
              <strong>{t('extensionsPanels.privacyPanel.actionLogBold')}</strong>{' '}
              {t('extensionsPanels.privacyPanel.helpIntroRest')}
            </p>
            <p>
              {t('extensionsPanels.privacyPanel.helpOverlayPrefix')}{' '}
              <strong>{t('extensionsPanels.privacyPanel.promptOverlayBold')}</strong>{' '}
              {t('extensionsPanels.privacyPanel.helpOverlayRest')}{' '}
              <strong>{t('extensionsPanels.privacyPanel.extractFromChat')}</strong>{' '}
              {t('extensionsPanels.privacyPanel.helpExtractRest')}
            </p>
          </HelpHint>
        </div>
        {onClose && (
          <Button size="icon" variant="ghost" onClick={onClose} aria-label={t('extensionsPanels.privacyPanel.closeAriaLabel')}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="px-4 py-3 space-y-4 text-xs">
          <section className="space-y-1.5">
            <h3 className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">
              {t('extensionsPanels.privacyPanel.storeHeading')}
            </h3>
            <p className="text-muted-foreground leading-relaxed">
              {t('extensionsPanels.privacyPanel.storeBody1Prefix')}{' '}
              <strong>{t('extensionsPanels.privacyPanel.actionLogBold')}</strong>{' '}
              {t('extensionsPanels.privacyPanel.storeBody1Rest')}
            </p>
            <p className="text-muted-foreground leading-relaxed">
              {t('extensionsPanels.privacyPanel.storeBody2')}
            </p>
          </section>

          <section className="space-y-1.5">
            <h3 className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">
              {t('extensionsPanels.privacyPanel.actionLogHeading')}
            </h3>
            <div className="rounded border bg-muted/30 px-3 py-2">
              <div>
                {t('extensionsPanels.privacyPanel.actionLogStats', {
                  events: logSize.events,
                  kib: (logSize.bytes / 1024).toFixed(1),
                })}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" onClick={handleExportLog} disabled={logSize.events === 0}>
                  <Download className="mr-1 h-3.5 w-3.5" />
                  {t('extensionsPanels.privacyPanel.exportJsonButton')}
                </Button>
                <Button size="sm" variant="outline" onClick={handleClearLog} disabled={logSize.events === 0}>
                  <Eraser className="mr-1 h-3.5 w-3.5" />
                  {t('extensionsPanels.privacyPanel.clearButton')}
                </Button>
              </div>
            </div>
          </section>

          <section className="space-y-1.5">
            <h3 className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">
              {t('extensionsPanels.privacyPanel.overlayHeading')}
            </h3>
            <p className="text-muted-foreground">
              {t('extensionsPanels.privacyPanel.overlayIntro')}
            </p>
            {!activeFlavor ? (
              <div className="rounded border bg-muted/30 px-3 py-2 text-muted-foreground italic">
                {t('extensionsPanels.privacyPanel.noActiveFlavor')}
              </div>
            ) : (
              <>
                <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <ScrollText className="h-3 w-3" />
                  {t('extensionsPanels.privacyPanel.editingOverlayFor')}{' '}
                  <span className="font-medium text-foreground">{activeFlavor.name}</span>
                </div>
                <textarea
                  className="w-full min-h-[160px] rounded border bg-background p-2 font-mono text-[11px] leading-relaxed"
                  value={overlayDraft}
                  onChange={(e) => {
                    setOverlayDraft(e.target.value);
                    setDirty(true);
                  }}
                  placeholder={t('extensionsPanels.privacyPanel.overlayPlaceholder')}
                />
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[10px] text-muted-foreground">
                    {t('extensionsPanels.privacyPanel.approxTokens', { tokens: Math.ceil(overlayDraft.length / 4) })}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="outline" onClick={handleExtractMemory} disabled={chatMessages.length === 0}>
                      <Brain className="mr-1 h-3.5 w-3.5" />
                      {t('extensionsPanels.privacyPanel.extractFromChat')}
                    </Button>
                    <Button size="sm" onClick={() => void handleSaveOverlay()} disabled={busy || !dirty}>
                      <Save className="mr-1 h-3.5 w-3.5" />
                      {t('extensionsPanels.privacyPanel.saveOverlayButton')}
                    </Button>
                  </div>
                </div>

                {proposals.length > 0 && (
                  <div className="rounded border bg-muted/30 px-3 py-2 space-y-2">
                    <div className="text-[11px] font-medium">
                      {t('extensionsPanels.privacyPanel.candidatePreferenceCount', { count: proposals.length })}
                    </div>
                    <div className="text-[10px] text-amber-700 dark:text-amber-400 italic">
                      {t('extensionsPanels.privacyPanel.ruleBasedWarning')}
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
                        {t('extensionsPanels.privacyPanel.discardButton')}
                      </Button>
                      <Button size="sm" onClick={handleAcceptProposals}>
                        {t('extensionsPanels.privacyPanel.addToOverlayButton')}
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
