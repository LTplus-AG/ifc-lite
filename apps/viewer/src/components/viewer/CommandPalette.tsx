/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useRetainedReportHost } from './retained-report-destination';
import { useSplitWidth } from './model/model-layout';
import { usePlacementGeorefContext } from '@/lib/geo/placement-georef-runtime';
import { usePersistentToolHosts } from './PersistentToolHosts';

/** Ctrl/Cmd+K command search with scoring and recent usage. Command DATA
 *  (icons, labels, actions) lives in `commandPaletteCommands.ts` and its two
 *  halves (#4918 slice 3) — this file is search/keyboard/rendering only. */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { Search, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { readCopyClipboard, subscribeCopyClipboard } from '@/lib/commands/modeling/copy-clipboard';
import { canRunPaletteCommand, palettePrerequisites } from './palette-availability';
import { useMountedFileHost, getMountedFileHost } from './toolbar/mounted-file-host';
import { useWebGPU } from '@/hooks/useWebGPU';
import type { SurfaceCommandContext } from './surface-command-types';
import { useViewerStore } from '@/store';
import { liftStartFold } from './welcome/useEmptyStartFold';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useSandbox } from '@/hooks/useSandbox';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import type { CommandContribution } from '@ifc-lite/extensions';
import { getRecentFiles, getCachedFileNames } from '@/lib/recent-files';
import type { RecentFileEntry } from '@/lib/recent-files';
import { closeActiveAnalysisExtension } from '@/services/analysis-extensions';
import { trackCommandExecution } from './surface-command-run';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import { buildCommandPaletteCommands, type RightPanel } from './commandPaletteCommands';
import { DynamicPaletteOption, RegisteredPaletteOption, registeredPaletteId } from './command-palette-option';
import { useExtensionDockDestinations } from '@/components/extensions/useExtensionDockDestinations';
import { useExportRunner } from './useExportRunner';
import {
  type Command,
  type Category,
  type FlatItem,
  browseCommands,
  searchCommands,
  getRecentIds,
  recordUsage,
} from './commandPaletteSearch';

/** Destinations reveal their canonical home, including detached panels (#8947). */
function activateRightPanel(panel: RightPanel) {
  closeActiveAnalysisExtension();
  liftStartFold('right');
  useViewerStore.getState().openPanelInHome(panel, 'palette');
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

/** Reveal the bottom destination; repeated invocation keeps its body open. */
function activateBottomPanel(panel: BottomPanelId) {
  closeActiveAnalysisExtension();
  liftStartFold('right');
  useViewerStore.getState().openPanelInHome(panel, 'palette');
}

// ── Component ──────────────────────────────────────────────────────────

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  surfaceContext?: Omit<SurfaceCommandContext, 'surface'>;
}

export function CommandPalette({ open, onOpenChange, surfaceContext }: CommandPaletteProps) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [query, setQuery] = useState('');
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const listId = useId();
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigatedByKeyboard = useRef(false);
  // Names currently in the blob cache, refreshed each open — lets recent-file clicks decide hit/miss without an async gap that would void user activation.
  const cachedNamesRef = useRef<Set<string>>(new Set());

  const dockDestinations = useExtensionDockDestinations();
  const fileHost = useMountedFileHost();
  const toolHosts = usePersistentToolHosts();
  const retainedReportHost = useRetainedReportHost();
  const splitWidth = useSplitWidth();
  const placementGeoref = usePlacementGeorefContext();
  const gpuStatus = useWebGPU();
  const { execute } = useSandbox();
  const extensionCommands = useSlotContributions<CommandContribution>('commandPalette');
  const extensionHost = useOptionalExtensionHost();
  const paletteLauncher = useRef<HTMLElement | null>(null);
  const currentExtensionHost = useRef(extensionHost);
  currentExtensionHost.current = extensionHost;

  useEffect(() => {
    if (open) {
      setRecentIds(getRecentIds());
      setRecentFiles(getRecentFiles());
      void getCachedFileNames().then((names) => { cachedNamesRef.current = new Set(names); });
      setQuery('');
      setSelectedOptionId(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep inspected prerequisites current without subscribing to unrelated viewport state.
  const copyClipboard = useSyncExternalStore(subscribeCopyClipboard, readCopyClipboard, readCopyClipboard);
  const prerequisites = useViewerStore(useShallow(palettePrerequisites));
  const collabRole = prerequisites.role;
  const canEditInSession = collabRole === null || collabRole === 'editor' || collabRole === 'admin';
  // Cesium only has something to show once a model carries georeferencing.
  const cesiumAvailable = useViewerStore((s) => s.cesiumAvailable);

  const { t, locale, revision } = useTranslation();
  const { runExport, dialog: exportDialog, extensionExporters } = useExportRunner();

  // ── Command definitions ── (data table: `commandPaletteCommands.ts`)
  const commands = useMemo<Command[]>(() => [...buildCommandPaletteCommands({
    execute,
    surfaceContext: { ...toolHosts, ...surfaceContext,
      entityActionsLauncher: () => paletteLauncher.current,
      openClassFilter: (surfaceContext?.openClassFilter ?? toolHosts.openClassFilter)
        ? () => (surfaceContext?.openClassFilter ?? toolHosts.openClassFilter)?.(paletteLauncher.current) : undefined,
      ...fileHost, fileHostIsCurrent: () => fileHost !== null && getMountedFileHost() === fileHost },
    recentFiles,
    cachedNames: cachedNamesRef,
    extensionCommands,
    extensionHost,
    extensionHostIsCurrent: () => currentExtensionHost.current === extensionHost,
    canEditInSession,
    cesiumAvailable,
    activateRightPanel,
    activateBottomPanel,
    runExport,
    extensionExporters,
  }), ...dockDestinations.commands], [dockDestinations.commands, execute, recentFiles, extensionCommands, extensionHost, canEditInSession, cesiumAvailable, runExport, extensionExporters, prerequisites, copyClipboard, fileHost, gpuStatus, retainedReportHost, splitWidth, placementGeoref, surfaceContext, toolHosts, locale, revision]);


  // ── Search: score, filter, sort ──
  // When searching, results are FLAT sorted by relevance — no category grouping.
  // When browsing (no query), results are grouped by category.
  const { grouped, flatItems } = useMemo(() => {
    if (!query.trim()) return browseCommands(commands, recentIds);
    const groups: { category: string; items: FlatItem[] }[] = [];
    const flat: FlatItem[] = [];
    let idx = 0;

    // ── Searching: flat ranked list, no categories ──
    const scored = searchCommands(commands, query, recentIds,
      cmd => cmd.labelKey ? t(cmd.labelKey, cmd.labelKeyParams) : cmd.label,
      cmd => t(CATEGORY_LABEL_KEY[cmd.category]));

    if (scored.length > 0) {
      const items: FlatItem[] = scored.map(cmd => {
        const item = { cmd, flatIdx: idx++ };
        flat.push(item);
        return item;
      });
      groups.push({ category: '', items }); // empty category = no header
    }
    return { grouped: groups, flatItems: flat };
  }, [commands, query, recentIds, t]);

  // Recent and category rows may contain the same command; each occurrence needs
  // its own stable id, independent of filtering, ordering, or another palette.
  const optionId = (commandId: string, category: string) =>
    `${listId}-${category === 'Recent' ? 'recent' : 'command'}-${encodeURIComponent(commandId)}`;
  const options = grouped.flatMap(group => group.items.map(item => ({
    ...item, optionId: optionId(item.cmd.id, group.category),
  })));
  const selectedIndex = Math.max(0, options.findIndex(item => item.optionId === selectedOptionId));
  const activeOption = options[selectedIndex];
  const activeOptionId = activeOption?.optionId;
  // Reconcile in this render: a passive effect can overwrite the open effect's
  // reset using the old list, leaving Open File selected beneath new recents.
  // Persist the resolved identity before any later live insertion can steal it.
  if (selectedOptionId !== (activeOptionId ?? null)) {
    setSelectedOptionId(activeOptionId ?? null);
  }

  useEffect(() => {
    if (!navigatedByKeyboard.current || !listRef.current) return;
    navigatedByKeyboard.current = false;
    const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, activeOptionId]);

  const runCommand = useCallback((cmd: Command) => {
    if (!canRunPaletteCommand(cmd)) return;
    onOpenChange(false);
    const activate = () => {
      if (!mounted.current) return;
      if (!canRunPaletteCommand(cmd, reason => toast.info(t(reason)))) return;
      recordUsage(cmd.id);
      if (!cmd.registryOwned) trackCommandExecution(cmd.id, 'palette');
      cmd.action();
    };
    // File picker activation stays in the trusted event stack.
    if (cmd.immediate) activate();
    else requestAnimationFrame(activate);
  }, [onOpenChange, t]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Enter confirms an IME candidate, not a command (#8946). keyCode 229
    // covers engines that clear isComposing on the final composition keydown.
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault(); navigatedByKeyboard.current = true;
      setSelectedOptionId(options[Math.min(selectedIndex + 1, options.length - 1)]?.optionId ?? null);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); navigatedByKeyboard.current = true;
      setSelectedOptionId(options[Math.max(selectedIndex - 1, 0)]?.optionId ?? null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = activeOption;
      if (item) runCommand(item.cmd);
    }
  }, [options, selectedIndex, activeOption, runCommand]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent overlayClassName="z-(--z-command-palette)" className="z-(--z-command-palette) flex flex-col p-0 gap-0 translate-y-0 w-[calc(100%_-_2rem)] max-w-lg overflow-hidden rounded-lg data-[state=open]:animate-none data-[state=closed]:animate-none"
          style={{ top: 'min(12dvh, 96px)', maxHeight: 'calc(100dvh - min(12dvh, 96px) - 16px)' }} aria-label={t('commandPalette.ariaLabel')} hideCloseButton
          onOpenAutoFocus={event => {
            event.preventDefault();
            paletteLauncher.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (paletteLauncher.current?.isConnected) paletteLauncher.current.focus();
          }}
          onEscapeKeyDown={event => {
            if (event.isComposing || event.keyCode === 229) event.preventDefault();
          }}>
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setSelectedOptionId(null); }}
              onKeyDown={handleKeyDown}
              role="combobox"
              aria-controls={listId}
              aria-expanded={open}
              aria-autocomplete="list"
              aria-activedescendant={activeOptionId}
              aria-label={t('commandPalette.searchAriaLabel')}
              placeholder={t('commandPalette.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoComplete="off"
              spellCheck={false}
            />
            <DialogClose className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('viewerShell.dialog.close')}>
              <X className="h-4 w-4" />
            </DialogClose>
          </div>

          {/* Results */}
          {/* The command palette implements a custom listbox with keyboard-managed button options. */}
          {/* eslint-disable-next-line jsx-a11y/prefer-tag-over-role */}
          <div id={listId} aria-label={t('commandPalette.searchAriaLabel')} ref={listRef} className="min-h-0 max-h-[420px] overflow-y-auto overscroll-contain scrollbar-thin py-1" role="listbox">
            {grouped.map((group) => (
              <div key={group.category || '__flat'} data-command-category={group.category}>
                {group.category && (
                  <div className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground select-none">
                    {t(CATEGORY_LABEL_KEY[group.category as Category])}
                  </div>
                )}
                {group.items.map(({ cmd, flatIdx }) => {
                  const placement = {
                    categoryLabel: query.trim() ? t(CATEGORY_LABEL_KEY[cmd.category]) : undefined,
                    id: optionId(cmd.id, group.category),
                    index: flatIdx,
                    selected: flatIdx === selectedIndex,
                    query,
                    onActivate: () => runCommand(cmd),
                    onHover: () => setSelectedOptionId(optionId(cmd.id, group.category)),
                  };
                  const key = `${group.category}:${cmd.id}`;
                  return cmd.registryOwned
                    ? <RegisteredPaletteOption key={key} commandId={registeredPaletteId(cmd)} projection={cmd} {...placement} />
                    : <DynamicPaletteOption key={key} command={cmd} {...placement} />;
                })}
              </div>
            ))}
          </div>

          {flatItems.length === 0 && (
            <div className="min-h-0 overflow-y-auto px-3 py-6 text-center text-sm text-muted-foreground">
              <output className="block">{t('commandPalette.noResults')}</output>
              <p className="mt-1">{t('commandPalette.noResultsHint')}</p>
              <button type="button" className="mt-3 rounded border px-3 py-2 text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => { setQuery(''); setSelectedOptionId(null); inputRef.current?.focus(); }}>
                {t('commandPalette.clearSearch')}
              </button>
            </div>
          )}

          {/* Footer */}
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 border-t text-xs text-muted-foreground select-none">
            {flatItems.length > 0 && <>
              <span><kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-mono text-xs">↑↓</kbd> {t('commandPalette.footer.navigate')}</span>
              <span><kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-mono text-xs">↵</kbd> {t('commandPalette.footer.run')}</span>
            </>}
            <span><kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-mono text-xs">{t('commandPalette.escKey')}</kbd> {t('commandPalette.footer.close')}</span>
          </div>
        </DialogContent>
      </Dialog>
      {/* Outside the palette's Dialog: an export dialog must outlive the palette closing. */}
      {exportDialog}
      {dockDestinations.dialog}
    </>
  );
}
