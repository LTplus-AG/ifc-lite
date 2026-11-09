/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mobile-optimized toolbar for the 3D viewport.
 * Compact, touch-friendly layout with essential actions visible
 * and secondary actions in an overflow menu.
 */

import { useMemo, useState } from 'react';
import { Download, MoreHorizontal } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { selectActiveLoadProgress } from '@/store/slices/loadingSlice';
import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { useFileCommands } from './toolbar/useFileCommands';
import { useExportRunner } from './useExportRunner';
import { buildExportCommands } from './commandPaletteExports';
import { surfaceCommand, type SurfaceCommandDefinition, type SurfaceCommandId } from './surface-commands';
import { runSurfaceCommand, trackCommandExecution } from './surface-command-run';
import { ActivityTrayDialog } from './activity/ActivityTray';

/** A phone target (#8802): the 36px face stays, and an invisible 4px
 * extension on every side makes the hit area 44x44. The 4px margins keep
 * neighbouring hit areas edge to edge, never overlapping. */
const PHONE_TARGET = 'relative h-9 w-9 mx-1 flex-shrink-0 after:absolute after:-inset-1 after:content-[""]';

export function MobileToolbar() {
  const { t } = useTranslation();
  const [activityOpen, setActivityOpen] = useState(false);
  const fileCommands = useFileCommands();
  const loading = useViewerStore(state => state.loading);
  const activeProgress = useViewerStore(selectActiveLoadProgress);
  const loadPercent = Math.round(activeProgress?.percent ?? 0);

  const { hasModelsLoaded } = fileCommands;
  const activeTool = useViewerStore((state) => state.activeTool);
  const selectedEntityId = useViewerStore((state) => state.selectedEntityId);
  const projectionMode = useViewerStore((state) => state.projectionMode);
  const theme = useViewerStore((state) => state.theme);

  // Multi-selection counts too (#5852): Hide acts on it even with no primary.
  const hasSelection = useViewerStore((state) => state.selectedEntityIds.size > 0) || selectedEntityId !== null;

  // Every export the toolbars and the palette offer, from the same registry
  // rows and through the same handlers and dialogs (#5842). The dialog is
  // hosted outside the menu so it outlives the menu closing.
  const { runExport, dialog: exportDialog, extensionExporters } = useExportRunner('mobile');
  const exportRows = useMemo(() => buildExportCommands(runExport, extensionExporters, 'mobile'), [runExport, extensionExporters]);

  const mobileState = { canEditInSession: true, projectionMode, theme };
  const mobileCommand = (id: SurfaceCommandId) => surfaceCommand(id, 'mobile');
  const mobileLabel = (command: SurfaceCommandDefinition) => t(command.mobileLabelKey?.(mobileState) ?? command.labelKey);
  const mobileIcon = (command: SurfaceCommandDefinition) => command.mobileIcon?.(mobileState) ?? command.icon;
  const runMobile = (command: SurfaceCommandDefinition) => runSurfaceCommand(command, { surface: 'mobile' });
  const openFile = mobileCommand('file:open');
  const addModel = mobileCommand('file:add-model');
  const OpenFileIcon = mobileIcon(openFile);
  const AddModelIcon = mobileIcon(addModel);
  const toolButtons = ['tool:select', 'tool:measure', 'tool:section'] as const;
  // Seven 44px targets fit a 320px phone in one row (7 x 44 = 308px); nine did
  // not, so Add model and Show all live in More (#8802, maintainer's call).
  const quickActions = ['view:home', 'view:fit'] as const;
  const walk = mobileCommand('tool:walk');
  const activity = mobileCommand('ui:activity');
  const ActivityIcon = mobileIcon(activity);
  const WalkIcon = mobileIcon(walk);
  const menuItem = (id: SurfaceCommandId, disabled = false) => {
    const command = mobileCommand(id);
    const Icon = mobileIcon(command);
    return (
      <DropdownMenuItem key={id} data-command-id={id} disabled={disabled} onClick={() => runMobile(command)}>
        <Icon className="h-4 w-4 mr-2" />
        {mobileLabel(command)}
      </DropdownMenuItem>
    );
  };

  return (
    // `box-content`: the bar's content box is the full 44px target height, so
    // no target is clipped by the bottom border.
    <div data-command-surface="mobile" className="flex items-center box-content px-1 h-11 border-b bg-white border-border relative z-50 overflow-x-auto">
      {fileCommands.fileInputs}

      {/* Open File */}
      <Button
        variant="ghost"
        size="icon-sm"
        className={PHONE_TARGET}
        data-command-id={openFile.id}
        onClick={() => runSurfaceCommand(openFile, { surface: 'mobile', openFiles: fileCommands.handleOpenClick })}
        disabled={loading}
        aria-label={mobileLabel(openFile)}
      >
        {loading ? (
          <Spinner size="md" />
        ) : (
          <OpenFileIcon className="h-4 w-4" />
        )}
      </Button>

      {/* Divider */}
      <div className="w-px h-5 bg-border flex-shrink-0" />

      {/* Tool buttons */}
      {toolButtons.map((id) => {
        const command = mobileCommand(id);
        const Icon = mobileIcon(command);
        const active = id === `tool:${activeTool}`;
        return (
          <Button
            key={id}
            data-command-id={id}
            // The shared active state (#8802), as on the desktop ribbon's
            // latched tool: tinted surface, active ink and an inset edge,
            // driven by `aria-pressed` so what is announced is what is shown.
            // At rest it keeps the foreground ink of the actions beside it.
            variant="toggle"
            size="icon-sm"
            className={`${PHONE_TARGET} text-foreground`}
            aria-pressed={active}
            onClick={() => runMobile(command)}
            aria-label={mobileLabel(command)}
          >
            <Icon className="h-4 w-4" />
          </Button>
        );
      })}

      {/* Divider */}
      <div className="w-px h-5 bg-border flex-shrink-0" />

      {/* Quick actions: Home, Fit, Show All */}
      {quickActions.map((id) => {
        const command = mobileCommand(id);
        const Icon = mobileIcon(command);
        return (
          <Button
            key={id}
            data-command-id={id}
            variant="ghost"
            size="icon-sm"
            className={PHONE_TARGET}
            onClick={() => runMobile(command)}
            aria-label={mobileLabel(command)}
          >
            <Icon className="h-4 w-4" />
          </Button>
        );
      })}

      {/* Spacer */}
      <div className="flex-1 min-w-0" />

      {/* Loading progress: a thin line along the bar's bottom edge, out of the
          row (#8802). In the row it took width the seven 44px targets need, so
          at 320px loading pushed More off-screen and the bar scrolled. It does
          not take taps; the loading card announces each phase. */}
      {loading && activeProgress && (
        // Native <progress>: a progressbar to assistive tech, indeterminate
        // when it has no value.
        <progress
          data-mobile-load-progress
          aria-label={t('viewportLighting.container.loadingCard.titleFallback')}
          aria-valuetext={activeProgress.indeterminate ? activeProgress.phase : `${activeProgress.phase} · ${loadPercent}%`}
          max={100}
          value={activeProgress.indeterminate ? undefined : loadPercent}
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 block h-0.5 w-full appearance-none overflow-hidden border-0 bg-primary/20',
            '[&::-webkit-progress-bar]:bg-primary/20 [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary',
            activeProgress.indeterminate && 'animate-pulse [&::-webkit-progress-bar]:bg-primary/60',
          )}
        />
      )}

      {/* Overflow menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={PHONE_TARGET}
            data-command-disclosure="mobile:more"
            aria-label={t('shellChrome.mobileToolbar.moreActionsAriaLabel')}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-mobile-command-menu align="end" className="w-64 max-h-[80vh] overflow-y-auto">
          {hasModelsLoaded && (
            <>
              <DropdownMenuItem
                data-command-id={addModel.id}
                disabled={loading}
                onClick={() => runSurfaceCommand(addModel, { surface: 'mobile', addModel: fileCommands.handleAddModelClick })}
              >
                <AddModelIcon className="h-4 w-4 mr-2" />
                {mobileLabel(addModel)}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {menuItem('ui:commands')}
          {menuItem('pref:settings')}
          <DropdownMenuSeparator />
          {/* Walk Mode */}
          <DropdownMenuCheckboxItem
            data-command-id={walk.id}
            checked={activeTool === 'walk'}
            onCheckedChange={() => runMobile(walk)}
          >
            <WalkIcon className="h-4 w-4 mr-2" />
            {mobileLabel(walk)}
          </DropdownMenuCheckboxItem>

          <DropdownMenuSeparator />

          {/* Visibility */}
          {menuItem('vis:isolate')}
          {menuItem('vis:hide', !hasSelection)}
          {menuItem('vis:show')}
          {hasSelection && menuItem('view:frame')}

          <DropdownMenuSeparator />

          {/* Camera */}
          {menuItem('view:projection')}

          <DropdownMenuSeparator />

          {/* Export: the registry's rows, same as the command palette. Inline
              rather than a submenu: a nested Radix submenu closes as a touch
              leaves its trigger, so its rows could not be tapped on a phone. */}
          <DropdownMenuLabel data-mobile-export-menu className="flex items-center text-xs text-muted-foreground">
            <Download className="h-3.5 w-3.5 mr-2" />
            {t('shellChrome.mobileToolbar.export')}
          </DropdownMenuLabel>
          {exportRows.map((row) => (
            <DropdownMenuItem key={row.id} data-export-row={row.id}
              data-extension-exporter-id={!row.registryOwned ? row.id : undefined}
              onClick={() => {
                if (!row.registryOwned) trackCommandExecution(row.id, 'mobile');
                row.action();
              }}>
              <row.icon className="h-4 w-4 mr-2" />
              {row.labelKey ? t(row.labelKey, row.labelKeyParams) : row.label}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />

          {/* The activity tray lives in the status bar, which phones do not show (#6925). */}
          <DropdownMenuItem data-command-id={activity.id} onClick={() => runSurfaceCommand(activity, { surface: 'mobile', openActivity: () => setActivityOpen(true) })}>
            <ActivityIcon className="h-4 w-4 mr-2" />
            {mobileLabel(activity)}
          </DropdownMenuItem>

          {/* Theme */}
          {menuItem('view:theme')}
        </DropdownMenuContent>
      </DropdownMenu>
      {exportDialog}
      <ActivityTrayDialog open={activityOpen} onOpenChange={setActivityOpen} />
    </div>
  );
}
