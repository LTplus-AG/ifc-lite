/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Ctrl/Cmd+K command search with scoring and recent usage. Command DATA
 *  (icons, labels, actions) lives in `commandPaletteCommands.ts` and its two
 *  halves (#4918 slice 3) — this file is search/keyboard/rendering only. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useSandbox } from '@/hooks/useSandbox';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import type { CommandContribution } from '@ifc-lite/extensions';
import { getRecentFiles, getCachedFileNames } from '@/lib/recent-files';
import type { RecentFileEntry } from '@/lib/recent-files';
import { closeActiveAnalysisExtension } from '@/services/analysis-extensions';
import { trackUiEvent } from '@/lib/analytics';
import { commandIdForAnalytics } from '@/lib/analytics-ui-events';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import { buildCommandPaletteCommands, type RightPanel } from './commandPaletteCommands';
import { usePaletteExportRunner } from './usePaletteExportRunner';
import {
  type Command,
  type Category,
  type FlatItem,
  browseCommands,
  rankCommand,
  getRecentIds,
  recordUsage,
} from './commandPaletteSearch';

/** Toggle a sidebar workspace panel (#1208). The store's `toggleWorkspacePanel`
 *  owns the single-tenant + re-dock + detach semantics; a second activation closes
 *  the panel back to the Information fallback. Closing any active analysis extension
 *  first preserves the prior "panels win the slot" behavior; kept as two thin helpers so every command action keeps its call site. */
function activateRightPanel(panel: RightPanel) {
  closeActiveAnalysisExtension();
  useViewerStore.getState().toggleWorkspacePanel(panel, 'palette');
}

/** Category header text, browse mode (#4918 slice 3). Exhaustive by type: a
 *  new `Category` value doesn't compile until it has a translation key. */
const CATEGORY_LABEL_KEY: Record<Category, TranslationKey> = {
  Recent: 'commandPalette.category.recent',
  File: 'commandPalette.category.file',
  View: 'commandPalette.category.view',
  Tools: 'commandPalette.category.tools',
  Visibility: 'commandPalette.category.visibility',
  Panels: 'commandPalette.category.panels',
  Export: 'commandPalette.category.export',
  Automation: 'commandPalette.category.automation',
  Preferences: 'commandPalette.category.preferences',
  Extensions: 'commandPalette.category.extensions',
  Learn: 'commandPalette.category.learn',
};

/** Bottom panel — mutually exclusive in the bottom strip, independent of the sidebar. The store
 *  owns the toggle, including the re-dock of a floating or popped-out panel; the hand-rolled flag
 *  flips that used to live here knew only the dock flags, so toggling a FLOATING Lists panel left it on screen with nothing latched. */
function activateBottomPanel(panel: BottomPanelId) {
  closeActiveAnalysisExtension();
  useViewerStore.getState().toggleBottomPanel(panel, 'palette');
}

// ── Component ──────────────────────────────────────────────────────────

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigatedByKeyboard = useRef(false);
  // Names currently in the blob cache, refreshed each open — lets recent-file clicks decide hit/miss without an async gap that would void user activation.
  const cachedNamesRef = useRef<Set<string>>(new Set());

  const { execute } = useSandbox();
  const extensionCommands = useSlotContributions<CommandContribution>('commandPalette');
  const extensionHost = useOptionalExtensionHost();

  useEffect(() => {
    if (open) {
      setRecentIds(getRecentIds());
      setRecentFiles(getRecentFiles());
      void getCachedFileNames().then((names) => { cachedNamesRef.current = new Set(names); });
      setQuery('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Collab role: in a shared session only editor/admin may author. Read reactively so authoring commands appear the moment a role is upgraded.
  const collabRole = useViewerStore((s) => s.collabRole);
  const canEditInSession = collabRole === null || collabRole === 'editor' || collabRole === 'admin';
  // Cesium only has something to show once a model carries georeferencing.
  const cesiumAvailable = useViewerStore((s) => s.cesiumAvailable);

  const { t } = useTranslation();
  const { runExport, dialog: exportDialog, extensionExporters } = usePaletteExportRunner();

  // ── Command definitions ── (data table: `commandPaletteCommands.ts`)
  const commands = useMemo<Command[]>(() => buildCommandPaletteCommands({
    execute,
    recentFiles,
    cachedNames: cachedNamesRef,
    extensionCommands,
    extensionHost,
    canEditInSession,
    cesiumAvailable,
    activateRightPanel,
    activateBottomPanel,
    runExport,
    extensionExporters,
  }), [execute, recentFiles, extensionCommands, extensionHost, canEditInSession, cesiumAvailable, runExport, extensionExporters]);


  // ── Search: score, filter, sort ──
  // When searching, results are FLAT sorted by relevance — no category grouping.
  // When browsing (no query), results are grouped by category.
  const { grouped, flatItems } = useMemo(() => {
    if (!query) return browseCommands(commands, recentIds);
    const groups: { category: string; items: FlatItem[] }[] = [];
    const flat: FlatItem[] = [];
    let idx = 0;

    // ── Searching: flat ranked list, no categories ──
    const scored = commands
      .map(cmd => ({ cmd, s: rankCommand(cmd, query, cmd.labelKey ? t(cmd.labelKey, cmd.labelKeyParams) : undefined) }))
      .filter(x => x.s > 0);
    scored.sort((a, b) => b.s - a.s);

    if (scored.length > 0) {
      const items: FlatItem[] = scored.map(({ cmd }) => {
        const item = { cmd, flatIdx: idx++ };
        flat.push(item);
        return item;
      });
      groups.push({ category: '', items }); // empty category = no header
    }
    return { grouped: groups, flatItems: flat };
  }, [commands, query, recentIds, t]);

  useEffect(() => { setSelectedIndex(0); }, [query, open]);

  useEffect(() => {
    if (!navigatedByKeyboard.current || !listRef.current) return;
    navigatedByKeyboard.current = false;
    const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const runCommand = useCallback((cmd: Command) => {
    onOpenChange(false);
    recordUsage(cmd.id);
    trackUiEvent('command_executed', { command_id: commandIdForAnalytics(cmd.id), surface: 'palette' });
    // File-dialog actions must run while user activation is still live; deferring
    // them to a frame later voids it and Chrome silently ignores the dialog.
    if (cmd.immediate) {
      cmd.action();
    } else {
      requestAnimationFrame(() => cmd.action());
    }
  }, [onOpenChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault(); navigatedByKeyboard.current = true;
      setSelectedIndex(i => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); navigatedByKeyboard.current = true;
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = flatItems[selectedIndex];
      if (item) runCommand(item.cmd);
    }
  }, [flatItems, selectedIndex, runCommand]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="p-0 gap-0 max-w-lg overflow-hidden" aria-label={t('commandPalette.ariaLabel')} hideCloseButton>
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2.5 border-b">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('commandPalette.searchPlaceholder')}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border bg-muted px-1.5 text-xs font-medium text-muted-foreground">
              {t('commandPalette.escKey')}
            </kbd>
          </div>

          {/* Results */}
          {/* The command palette implements a custom listbox with keyboard-managed button options. */}
          {/* eslint-disable-next-line jsx-a11y/prefer-tag-over-role */}
          <div ref={listRef} className="max-h-[min(420px,60vh)] overflow-y-auto py-1" role="listbox">
            {flatItems.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                {t('commandPalette.noResults')}
              </div>
            )}

            {grouped.map((group) => (
              <div key={group.category || '__flat'}>
                {group.category && (
                  <div className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
                    {t(CATEGORY_LABEL_KEY[group.category as Category])}
                  </div>
                )}
                {group.items.map(({ cmd, flatIdx }) => {
                  const Icon = cmd.icon;
                  return (
                    // The option remains a button so Enter and click use the same command action.
                    // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
                    <button role="option"
                      key={`${group.category}:${cmd.id}`}
                      data-index={flatIdx}
                      aria-selected={flatIdx === selectedIndex}
                      className={cn(
                        'flex items-center gap-3 w-full px-3 py-2 text-left text-sm',
                        flatIdx === selectedIndex
                          ? 'bg-accent text-accent-foreground'
                          : 'text-foreground hover:bg-accent/50',
                      )}
                      onClick={() => runCommand(cmd)}
                      onMouseMove={() => { if (selectedIndex !== flatIdx) setSelectedIndex(flatIdx); }}
                    >
                      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="flex-1 truncate">{cmd.labelKey ? t(cmd.labelKey, cmd.labelKeyParams) : cmd.label}</span>
                      {cmd.detail && (
                        <span className="text-xs text-muted-foreground shrink-0">
                          {cmd.detailKey ? t(cmd.detailKey, cmd.detailKeyParams) : cmd.detail}
                        </span>
                      )}
                      {cmd.shortcut && (
                        <kbd className="ml-auto hidden sm:inline-flex h-5 min-w-[20px] items-center justify-center rounded border bg-muted px-1.5 text-xs font-medium text-muted-foreground shrink-0">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="flex items-center gap-4 px-3 py-1.5 border-t text-xs text-muted-foreground select-none">
            <span><kbd className="font-mono">↑↓</kbd> {t('commandPalette.footer.navigate')}</span>
            <span><kbd className="font-mono">↵</kbd> {t('commandPalette.footer.run')}</span>
            <span><kbd className="font-mono">{t('commandPalette.escKey')}</kbd> {t('commandPalette.footer.close')}</span>
          </div>
        </DialogContent>
      </Dialog>
      {/* Outside the palette's Dialog: an export dialog must outlive the palette closing. */}
      {exportDialog}
    </>
  );
}
