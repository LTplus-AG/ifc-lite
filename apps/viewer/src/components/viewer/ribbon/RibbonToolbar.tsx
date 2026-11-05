/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Desktop ribbon toolbar: a slim 32px tab strip selects a command context,
 * and a 48px band beneath lays its commands out in named groups split by
 * hairline dividers (80px in all, down from 128px; #8802 R1).
 *
 * Office conventions kept: double-click the active tab (or the chevron)
 * to collapse the band to the tab strip; the collapsed state persists.
 * The active tab also follows the working context (see
 * `useRibbonContextualTab`), which the user can turn off in View.
 */

import React from 'react';
import { ChevronDown, ChevronUp, HelpCircle, Search } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { selectActiveLoadProgress } from '@/store/slices/loadingSlice';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore, type RibbonTabId } from '@/store';
import { cn } from '@/lib/utils';
import { useTranslation, type TranslationKey } from '@/i18n';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { ThemeSwitch } from '../ThemeSwitch';
import { SearchInline } from '../SearchInline';
import { ExportChangesButton } from '../ExportChangesButton';
import { ExtensionToolbarSlot } from '@/components/extensions/ExtensionToolbarSlot';
import { useFileCommands } from '../toolbar/useFileCommands';
import { FileTab } from './tabs/FileTab';
import { HomeTab } from './tabs/HomeTab';
import { ViewTab } from './tabs/ViewTab';
import { ElementsTab } from './tabs/ElementsTab';
import { AnalyzeTab } from './tabs/AnalyzeTab';
import { AuthorTab } from './tabs/AuthorTab';
import { RibbonSwitchNotice } from './RibbonSwitchNotice';
import { useRibbonContextualTab } from './useRibbonContextualTab';
import { RibbonCommandSmallButton } from './command-button';
import { Settings } from '@/icons';
import { emitOpenCommandPalette } from '@/lib/tours/events';

const RIBBON_TABS: { id: RibbonTabId; labelKey: TranslationKey }[] = [
  { id: 'file', labelKey: 'ribbon.tab.file' },
  { id: 'home', labelKey: 'ribbon.tab.home' },
  { id: 'view', labelKey: 'ribbon.tab.view' },
  { id: 'elements', labelKey: 'ribbon.tab.elements' },
  { id: 'analyze', labelKey: 'ribbon.tab.analyze' },
  { id: 'author', labelKey: 'ribbon.tab.author' },
];

interface RibbonToolbarProps {
  onShowShortcuts?: () => void;
}

export function RibbonToolbar({ onShowShortcuts }: RibbonToolbarProps = {} as RibbonToolbarProps) {
  // The active tab lives in the store so the contextual driver and the
  // walkthrough can open one; it starts on Home and is never persisted.
  const { t } = useTranslation();
  const activeTab = useViewerStore((s) => s.ribbonTab);
  const setActiveTab = useViewerStore((s) => s.setRibbonTab);
  const ribbonCollapsed = useViewerStore((s) => s.ribbonCollapsed);
  const setRibbonCollapsed = useViewerStore((s) => s.setRibbonCollapsed);

  useRibbonContextualTab();

  // Shared command surface — registers the global load listeners and the
  // hidden file inputs exactly once for this toolbar style.
  const fileCommands = useFileCommands();

  // Narrow selectors: `useIfc()` also subscribes to `models` / `geometryResult` (#6232).
  const loading = useViewerStore((s) => s.loading);
  const geometryProgress = useViewerStore((s) => s.geometryProgress);
  const metadataProgress = useViewerStore((s) => s.metadataProgress);
  const activeProgress = useViewerStore(selectActiveLoadProgress);

  const handleTabClick = (id: RibbonTabId) => {
    if (id === activeTab && !ribbonCollapsed) return;
    setActiveTab(id);
    // Clicking any tab while collapsed re-opens the band (Office pins on click).
    if (ribbonCollapsed) setRibbonCollapsed(false);
  };

  return (
    <Tabs value={activeTab} onValueChange={(value) => handleTabClick(value as RibbonTabId)} className="relative z-50 border-b border-divider bg-panel">
      {fileCommands.fileInputs}

      {/* ── Tab strip ── */}
      <div className="flex h-8 items-center gap-0.5 px-2">
        <TabsList
          aria-label={t('ribbon.tabsAriaLabel')}
          className="flex h-full items-end justify-start gap-0.5 rounded-none bg-transparent p-0"
          {...tourAnchor(TOUR_ANCHORS.ribbonTabs)}
        >
          {RIBBON_TABS.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                onClick={() => { if (isActive && ribbonCollapsed) setRibbonCollapsed(false); }}
                onDoubleClick={() => {
                  if (isActive) setRibbonCollapsed(!ribbonCollapsed);
                }}
                className={cn(
                  'relative flex h-8 select-none items-center rounded-t-md px-2.5 text-xs font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  'bg-transparent shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none',
                  isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(tab.labelKey)}
                {/* Drafting-pen underline for the active tab — reads in
                    every theme without a filled pill. */}
                {isActive && (
                  <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {/* Loading progress — lives in the strip so it survives collapse.
            Left of the spacer, next to the tabs: anything to the RIGHT of
            it would slide sideways every time a load starts or ends, and
            the search field is over there. */}
        {loading && activeProgress && (
          <div className="ml-3 flex min-w-0 items-center gap-2">
            <span className="max-w-56 truncate text-xs text-muted-foreground">
              {activeProgress.phase}
              {geometryProgress && metadataProgress ? ` | ${metadataProgress.phase}` : ''}
            </span>
            {activeProgress.indeterminate ? (
              <Spinner size="sm" className="text-muted-foreground" />
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

        <div className="flex-1" />

        {/* Inline search uses the shared SearchInline component, so `/` and
            ⌘F focus this field. The n/N result cycle, recent-search popover,
            and "N filter rules active" badge (with its one-click
            clear) remain available. It sits in the tab strip rather than
            inside a tab so it survives collapse and tab switches.

            Right-oriented: the tab strip's left edge is tab geography, so
            a field parked there competes with the tabs for the same
            reading position and slides sideways whenever the tab set
            changes. Docked to the right it lands where a search field is
            looked for, beside the rest of the always-on chrome. */}
        <div className="mr-2 min-w-0">
          <SearchInline compact />
        </div>

        {/* Extension toolbar contributions, right-aligned beside search. */}
        <ExtensionToolbarSlot slot="toolbar.right" />

        {/* Export modified IFC… — pending-mutation affordance must stay visible
            regardless of the active tab or collapse state. */}
        <ExportChangesButton surface="ribbon" />

        <div className="ml-1 flex shrink-0 items-center gap-0.5 border-l border-divider pl-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 whitespace-nowrap px-2 text-xs font-normal"
            onClick={emitOpenCommandPalette}
          >
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            {t('ribbon.commands')}
            <kbd className="rounded border border-divider px-1 font-sans text-2xs text-muted-foreground">{t('ribbon.commandsShortcut')}</kbd>
          </Button>
          <RibbonCommandSmallButton commandId="pref:settings" icon={Settings} className="h-7 w-auto shrink-0 whitespace-nowrap px-2 text-xs" />
          <ThemeSwitch />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('ribbon.infoAriaLabel')}
                onClick={() => onShowShortcuts?.()}
              >
                <HelpCircle className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('ribbon.infoTooltip')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={ribbonCollapsed ? t('ribbon.expand') : t('ribbon.collapse')}
                aria-expanded={!ribbonCollapsed}
                onClick={() => setRibbonCollapsed(!ribbonCollapsed)}
                {...tourAnchor(TOUR_ANCHORS.ribbonCollapse)}
              >
                {ribbonCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{ribbonCollapsed ? t('ribbon.expand') : t('ribbon.collapse')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* ── Band ── */}
      {!ribbonCollapsed && (
        <TabsContent
          value={activeTab}
          aria-label={t('ribbon.bandAriaLabel', { tab: t(`ribbon.tab.${activeTab}`) })}
          // The band's own height is its content's; a horizontal scrollbar
          // (narrow windows) adds below the 48px row instead of squeezing it.
          className="shell-ribbon-band mt-0 overflow-x-auto overflow-y-hidden"
        >
          <div className="flex h-12 w-max min-w-full items-stretch px-1">
            {activeTab === 'file' && <FileTab fileCommands={fileCommands} />}
            {activeTab === 'home' && <HomeTab />}
            {activeTab === 'view' && <ViewTab />}
            {activeTab === 'elements' && <ElementsTab />}
            {activeTab === 'analyze' && <AnalyzeTab />}
            {activeTab === 'author' && <AuthorTab />}
          </div>
        </TabsContent>
      )}

      {/* One-time "the toolbar changed" line, with the way back. Sits under
          the band so it never displaces a command the user is reaching for. */}
      <RibbonSwitchNotice />
    </Tabs>
  );
}
