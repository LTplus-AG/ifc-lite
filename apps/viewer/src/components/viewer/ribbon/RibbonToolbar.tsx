/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon toolbar (issue #1686) — the tabbed, IFCFlux/Office-style
 * alternative to the classic single-strip `MainToolbar`. A slim tab
 * strip selects a command context; the band beneath lays the commands
 * out in labeled groups with visible names, trading one strip of
 * vertical space for zero-recall discovery. Selected per user via
 * `uiSlice.toolbarStyle`; both styles drive the same shared command
 * hooks so behaviour can never fork.
 *
 * Office conventions kept: double-click the active tab (or the chevron)
 * to collapse the band to the tab strip; the collapsed state persists.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, HelpCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { cn } from '@/lib/utils';
import { SearchInline } from '../SearchInline';
import { ThemeSwitch } from '../ThemeSwitch';
import { ExportChangesButton } from '../ExportChangesButton';
import { ExtensionToolbarSlot } from '@/components/extensions/ExtensionToolbarSlot';
import { useFileCommands } from '../toolbar/useFileCommands';
import { FileTab } from './tabs/FileTab';
import { HomeTab } from './tabs/HomeTab';
import { ViewTab } from './tabs/ViewTab';
import { AnalyzeTab } from './tabs/AnalyzeTab';
import { AuthorTab } from './tabs/AuthorTab';

type RibbonTabId = 'file' | 'home' | 'view' | 'analyze' | 'author';

const RIBBON_TABS: { id: RibbonTabId; label: string }[] = [
  { id: 'file', label: 'File' },
  { id: 'home', label: 'Home' },
  { id: 'view', label: 'View' },
  { id: 'analyze', label: 'Analyze' },
  { id: 'author', label: 'Author' },
];

interface RibbonToolbarProps {
  onShowShortcuts?: () => void;
}

export function RibbonToolbar({ onShowShortcuts }: RibbonToolbarProps = {} as RibbonToolbarProps) {
  // Home first: it holds the everyday loop (tools, selection, camera).
  const [activeTab, setActiveTab] = useState<RibbonTabId>('home');
  const ribbonCollapsed = useViewerStore((s) => s.ribbonCollapsed);
  const setRibbonCollapsed = useViewerStore((s) => s.setRibbonCollapsed);

  // Shared command surface — registers the global load listeners and the
  // hidden file inputs exactly once for this toolbar style.
  const fileCommands = useFileCommands();

  const { loading, progress, geometryProgress, metadataProgress } = useIfc();
  const error = useViewerStore((state) => state.error);
  const activeProgress = geometryProgress ?? metadataProgress ?? progress;

  const handleTabClick = (id: RibbonTabId) => {
    if (id === activeTab && !ribbonCollapsed) return;
    setActiveTab(id);
    // Clicking any tab while collapsed re-opens the band (Office pins on click).
    if (ribbonCollapsed) setRibbonCollapsed(false);
  };

  return (
    <div className="relative z-50 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
      {fileCommands.fileInputs}

      {/* ── Tab strip ── */}
      <div className="flex h-10 items-center gap-0.5 border-b border-zinc-200/70 px-2 dark:border-zinc-800/70">
        <div role="tablist" aria-label="Ribbon tabs" className="flex h-full items-end gap-0.5">
          {RIBBON_TABS.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => handleTabClick(tab.id)}
                onDoubleClick={() => {
                  if (isActive) setRibbonCollapsed(!ribbonCollapsed);
                }}
                className={cn(
                  'relative flex h-8 select-none items-center rounded-t-md px-3 text-xs font-medium tracking-wide transition-colors',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                {tab.label}
                {/* Drafting-pen underline for the active tab — reads in
                    every theme without a filled pill. */}
                {isActive && (
                  <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />
                )}
              </button>
            );
          })}
        </div>

        <div className="flex-1" />

        {/* Loading progress — lives in the strip so it survives collapse. */}
        {loading && activeProgress && (
          <div className="mr-2 flex items-center gap-2">
            <span className="max-w-56 truncate text-xs text-muted-foreground">
              {activeProgress.phase}
              {geometryProgress && metadataProgress ? ` | ${metadataProgress.phase}` : ''}
            </span>
            {activeProgress.indeterminate ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : (
              <>
                <Progress value={activeProgress.percent ?? 0} className="h-2 w-28" />
                <span className="text-xs tabular-nums text-muted-foreground">
                  {Math.round(activeProgress.percent ?? 0)}%
                </span>
              </>
            )}
          </div>
        )}

        {/* Error Display */}
        {error && (
          <span className="mr-2 max-w-72 truncate text-xs text-destructive">{error}</span>
        )}

        {/* Search lives in the strip (Office puts it in the title row):
            always visible, collapse-proof, and anchored to real chrome
            instead of floating in the band. max-h trims the h-9 input to
            the strip's rhythm without forking SearchInline. */}
        <div className="mr-1 hidden md:block [&_input]:max-h-8">
          <SearchInline />
        </div>

        {/* Extension toolbar contributions (right-aligned, same slot as
            the classic toolbar). */}
        <ExtensionToolbarSlot slot="toolbar.right" />

        {/* Export Changes — pending-mutation affordance must stay visible
            regardless of the active tab or collapse state. */}
        <ExportChangesButton />

        <div className="ml-1 flex items-center gap-1 border-l border-zinc-200 pl-2 dark:border-zinc-700/60">
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <ThemeSwitch />
              </div>
            </TooltipTrigger>
            <TooltipContent>Toggle theme (Shift+click for secret mode)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Info and keyboard shortcuts"
                onClick={() => onShowShortcuts?.()}
              >
                <HelpCircle className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Info (?)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={ribbonCollapsed ? 'Expand the ribbon' : 'Collapse the ribbon'}
                aria-expanded={!ribbonCollapsed}
                onClick={() => setRibbonCollapsed(!ribbonCollapsed)}
              >
                {ribbonCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{ribbonCollapsed ? 'Expand the ribbon' : 'Collapse the ribbon'}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* ── Band ── */}
      {!ribbonCollapsed && (
        <div
          role="tabpanel"
          aria-label={`${activeTab} commands`}
          className="flex h-[88px] items-stretch overflow-x-auto overflow-y-hidden px-1"
        >
          {activeTab === 'file' && <FileTab fileCommands={fileCommands} />}
          {activeTab === 'home' && <HomeTab />}
          {activeTab === 'view' && <ViewTab />}
          {activeTab === 'analyze' && <AnalyzeTab />}
          {activeTab === 'author' && <AuthorTab />}
        </div>
      )}
    </div>
  );
}
