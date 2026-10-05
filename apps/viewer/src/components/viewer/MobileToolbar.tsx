/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mobile-optimized toolbar for the 3D viewport.
 * Compact, touch-friendly layout with essential actions visible
 * and secondary actions in an overflow menu.
 */

import React, { useRef, useCallback, useMemo, useState } from 'react';
import { Activity, Download, MoreHorizontal } from 'lucide-react';
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
import { Progress } from '@/components/ui/progress';
import { selectActiveLoadProgress } from '@/store/slices/loadingSlice';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { useIfc } from '@/hooks/useIfc';
import { cn } from '@/lib/utils';
import { useExportRunner } from './useExportRunner';
import { buildExportCommands } from './commandPaletteExports';
import { recordRecentFiles, cacheFileBlobs } from '@/lib/recent-files';
import { reportFileOpenRejected } from '@/hooks/ingest/fileOpenRejected';
import { MOBILE_FILE_ACCEPT, isSupportedMobileModelFile } from '@/services/supported-model-files';
import { surfaceCommand, type SurfaceCommandDefinition, type SurfaceCommandId } from './surface-commands';
import { runSurfaceCommand, trackCommandExecution } from './surface-command-run';
import { ActivityTrayDialog, useActivityMenuLabel } from './activity/ActivityTray';

export function MobileToolbar() {
  const { t } = useTranslation();
  const [activityOpen, setActivityOpen] = useState(false);
  const activityLabel = useActivityMenuLabel();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addModelInputRef = useRef<HTMLInputElement>(null);
  const {
    loadFile,
    loading,
    geometryResult,
    models,
    loadFilesSequentially,
  } = useIfc();
  const activeProgress = useViewerStore(selectActiveLoadProgress);

  const hasModelsLoaded = models.size > 0 || (geometryResult?.meshes && geometryResult.meshes.length > 0);
  const activeTool = useViewerStore((state) => state.activeTool);
  const selectedEntityId = useViewerStore((state) => state.selectedEntityId);
  const resetViewerState = useViewerStore((state) => state.resetViewerState);
  const clearAllModels = useViewerStore((state) => state.clearAllModels);
  const projectionMode = useViewerStore((state) => state.projectionMode);
  const theme = useViewerStore((state) => state.theme);

  // Multi-selection counts too (#5852): Hide acts on it even with no primary.
  const hasSelection = useViewerStore((state) => state.selectedEntityIds.size > 0) || selectedEntityId !== null;

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const supportedFiles = Array.from(files).filter(isSupportedMobileModelFile);
    if (supportedFiles.length === 0) { reportFileOpenRejected(Array.from(files)); return; }
    recordRecentFiles(supportedFiles.map((file) => ({ name: file.name, size: file.size })));
    void cacheFileBlobs(supportedFiles);
    if (supportedFiles.length === 1) {
      loadFile(supportedFiles[0]);
    } else {
      resetViewerState();
      clearAllModels();
      loadFilesSequentially(supportedFiles);
    }
    e.target.value = '';
  }, [loadFile, loadFilesSequentially, resetViewerState, clearAllModels]);

  const handleAddModelSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const supportedFiles = Array.from(files).filter(isSupportedMobileModelFile);
    if (supportedFiles.length === 0) { reportFileOpenRejected(Array.from(files)); return; }
    recordRecentFiles(supportedFiles.map((file) => ({ name: file.name, size: file.size })));
    void cacheFileBlobs(supportedFiles);
    loadFilesSequentially(supportedFiles);
    e.target.value = '';
  }, [loadFilesSequentially]);

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
  const quickActions = ['view:home', 'view:fit', 'vis:show'] as const;
  const walk = mobileCommand('tool:walk');
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
    <div data-command-surface="mobile" className="flex items-center gap-0.5 px-1.5 h-11 border-b bg-white dark:bg-black border-zinc-200 dark:border-zinc-800 relative z-50 overflow-x-auto">
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept={MOBILE_FILE_ACCEPT}
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />
      <input
        ref={addModelInputRef}
        type="file"
        accept={MOBILE_FILE_ACCEPT}
        multiple
        onChange={handleAddModelSelect}
        className="hidden"
      />

      {/* Open File */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-9 w-9 flex-shrink-0"
        data-command-id={openFile.id}
        onClick={() => runSurfaceCommand(openFile, { surface: 'mobile', openFiles: () => fileInputRef.current?.click() })}
        disabled={loading}
        aria-label={mobileLabel(openFile)}
      >
        {loading ? (
          <Spinner size="md" />
        ) : (
          <OpenFileIcon className="h-4 w-4" />
        )}
      </Button>

      {/* Add Model */}
      {hasModelsLoaded && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-9 w-9 flex-shrink-0 text-[#9ece6a]"
          data-command-id={addModel.id}
          onClick={() => runSurfaceCommand(addModel, { surface: 'mobile', addModel: () => addModelInputRef.current?.click() })}
          disabled={loading}
          aria-label={mobileLabel(addModel)}
        >
          <AddModelIcon className="h-4 w-4" />
        </Button>
      )}

      {/* Divider */}
      <div className="w-px h-5 bg-border mx-0.5 flex-shrink-0" />

      {/* Tool buttons */}
      {toolButtons.map((id) => {
        const command = mobileCommand(id);
        const Icon = mobileIcon(command);
        const active = id === `tool:${activeTool}`;
        return (
          <Button
            key={id}
            data-command-id={id}
            variant={active ? 'default' : 'ghost'}
            size="icon-sm"
            className={cn('h-9 w-9 flex-shrink-0', active && 'bg-primary text-primary-foreground')}
            onClick={() => runMobile(command)}
            aria-label={mobileLabel(command)}
          >
            <Icon className="h-4 w-4" />
          </Button>
        );
      })}

      {/* Divider */}
      <div className="w-px h-5 bg-border mx-0.5 flex-shrink-0" />

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
            className="h-9 w-9 flex-shrink-0"
            onClick={() => runMobile(command)}
            aria-label={mobileLabel(command)}
          >
            <Icon className="h-4 w-4" />
          </Button>
        );
      })}

      {/* Spacer */}
      <div className="flex-1 min-w-2" />

      {/* Loading progress (compact) */}
      {loading && activeProgress && (
        <div className="flex items-center gap-1.5 mr-1 flex-shrink-0">
          <Progress value={activeProgress.percent} className="w-16 h-1.5" />
          <span className="text-2xs text-muted-foreground tabular-nums">
            {Math.round(activeProgress.percent)}%
          </span>
        </div>
      )}

      {/* Overflow menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-9 w-9 flex-shrink-0"
            data-command-disclosure="mobile:more"
            aria-label={t('shellChrome.mobileToolbar.moreActionsAriaLabel')}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-mobile-command-menu align="end" className="w-64 max-h-[80vh] overflow-y-auto">
          {menuItem('ui:commands')}
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
          <DropdownMenuItem data-mobile-activity onClick={() => setActivityOpen(true)}>
            <Activity className="h-4 w-4 mr-2" />
            {activityLabel}
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
