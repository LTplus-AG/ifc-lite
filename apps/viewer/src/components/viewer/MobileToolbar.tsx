/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mobile-optimized toolbar for the 3D viewport.
 * Compact, touch-friendly layout with essential actions visible
 * and secondary actions in an overflow menu.
 */

import React, { useRef, useCallback, useMemo } from 'react';
import {
  FolderOpen,
  MousePointer2,
  Ruler,
  Scissors,
  Eye,
  EyeOff,
  Home,
  Maximize2,
  Crosshair,
  Loader2,
  MoreHorizontal,
  Plus,
  Download,
  Orbit,
  Sun,
  Moon,
  PersonStanding,
} from 'lucide-react';
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
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { goHomeFromStore, resetVisibilityForHomeFromStore } from '@/store/homeView';
import { executeBasketIsolate } from '@/store/basket/basketCommands';
import { useIfc } from '@/hooks/useIfc';
import { cn } from '@/lib/utils';
import { useExportRunner } from './useExportRunner';
import { buildExportCommands } from './commandPaletteExports';
import { recordRecentFiles, cacheFileBlobs } from '@/lib/recent-files';
import { MOBILE_FILE_ACCEPT, isSupportedMobileModelFile } from '@/services/supported-model-files';

type Tool = 'select' | 'walk' | 'measure' | 'section';

export function MobileToolbar() {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addModelInputRef = useRef<HTMLInputElement>(null);
  const {
    loadFile,
    loading,
    progress,
    geometryProgress,
    metadataProgress,
    geometryResult,
    models,
    loadFilesSequentially,
  } = useIfc();

  const hasModelsLoaded = models.size > 0 || (geometryResult?.meshes && geometryResult.meshes.length > 0);
  const activeTool = useViewerStore((state) => state.activeTool);
  const setActiveTool = useViewerStore((state) => state.setActiveTool);
  const selectedEntityId = useViewerStore((state) => state.selectedEntityId);
  const hideEntities = useViewerStore((state) => state.hideEntities);
  const error = useViewerStore((state) => state.error);
  const cameraCallbacks = useViewerStore((state) => state.cameraCallbacks);
  const resetViewerState = useViewerStore((state) => state.resetViewerState);
  const clearAllModels = useViewerStore((state) => state.clearAllModels);
  const projectionMode = useViewerStore((state) => state.projectionMode);
  const toggleProjectionMode = useViewerStore((state) => state.toggleProjectionMode);
  const theme = useViewerStore((state) => state.theme);
  const toggleTheme = useViewerStore((state) => state.toggleTheme);

  const hasSelection = selectedEntityId !== null;

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const supportedFiles = Array.from(files).filter(isSupportedMobileModelFile);
    if (supportedFiles.length === 0) return;
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
    if (supportedFiles.length === 0) return;
    recordRecentFiles(supportedFiles.map((file) => ({ name: file.name, size: file.size })));
    void cacheFileBlobs(supportedFiles);
    loadFilesSequentially(supportedFiles);
    e.target.value = '';
  }, [loadFilesSequentially]);

  const handleIsolate = useCallback(() => {
    executeBasketIsolate();
  }, []);

  const handleShowAll = useCallback(() => {
    resetVisibilityForHomeFromStore();
  }, []);

  const handleHide = useCallback(() => {
    if (selectedEntityId !== null) {
      hideEntities([selectedEntityId]);
    }
  }, [selectedEntityId, hideEntities]);

  const handleHome = useCallback(() => {
    goHomeFromStore();
  }, []);

  // Every export the toolbars and the palette offer, from the same registry
  // rows and through the same handlers and dialogs (#5842). The dialog is
  // hosted outside the menu so it outlives the menu closing.
  const { runExport, dialog: exportDialog, extensionExporters } = useExportRunner();
  const exportRows = useMemo(() => buildExportCommands(runExport, extensionExporters), [runExport, extensionExporters]);

  const toolButtons: { tool: Tool; icon: React.ElementType; label: string }[] = [
    { tool: 'select', icon: MousePointer2, label: t('shellChrome.mobileToolbar.selectTool') },
    { tool: 'measure', icon: Ruler, label: t('shellChrome.mobileToolbar.measureTool') },
    { tool: 'section', icon: Scissors, label: t('shellChrome.mobileToolbar.sectionTool') },
  ];

  return (
    <div className="flex items-center gap-0.5 px-1.5 h-11 border-b bg-white dark:bg-black border-zinc-200 dark:border-zinc-800 relative z-50 overflow-x-auto">
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
        onClick={() => {
          fileInputRef.current?.click();
        }}
        disabled={loading}
        aria-label={t('shellChrome.mobileToolbar.openFileAriaLabel')}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <FolderOpen className="h-4 w-4" />
        )}
      </Button>

      {/* Add Model */}
      {hasModelsLoaded && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-9 w-9 flex-shrink-0 text-[#9ece6a]"
          onClick={() => addModelInputRef.current?.click()}
          disabled={loading}
          aria-label={t('shellChrome.mobileToolbar.addModelAriaLabel')}
        >
          <Plus className="h-4 w-4" />
        </Button>
      )}

      {/* Divider */}
      <div className="w-px h-5 bg-border mx-0.5 flex-shrink-0" />

      {/* Tool buttons */}
      {toolButtons.map(({ tool, icon: Icon, label }) => (
        <Button
          key={tool}
          variant={activeTool === tool ? 'default' : 'ghost'}
          size="icon-sm"
          className={cn('h-9 w-9 flex-shrink-0', activeTool === tool && 'bg-primary text-primary-foreground')}
          onClick={() => setActiveTool(tool)}
          aria-label={label}
        >
          <Icon className="h-4 w-4" />
        </Button>
      ))}

      {/* Divider */}
      <div className="w-px h-5 bg-border mx-0.5 flex-shrink-0" />

      {/* Quick actions: Home, Fit, Show All */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-9 w-9 flex-shrink-0"
        onClick={handleHome}
        aria-label={t('shellChrome.mobileToolbar.homeAriaLabel')}
      >
        <Home className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-9 w-9 flex-shrink-0"
        onClick={() => cameraCallbacks.fitAll?.()}
        aria-label={t('shellChrome.mobileToolbar.fitAllAriaLabel')}
      >
        <Maximize2 className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-9 w-9 flex-shrink-0"
        onClick={handleShowAll}
        aria-label={t('shellChrome.mobileToolbar.showAllAriaLabel')}
      >
        <Eye className="h-4 w-4" />
      </Button>

      {/* Spacer */}
      <div className="flex-1 min-w-2" />

      {/* Loading progress (compact) */}
      {loading && (geometryProgress || metadataProgress || progress) && (
        <div className="flex items-center gap-1.5 mr-1 flex-shrink-0">
          <Progress value={(geometryProgress ?? metadataProgress ?? progress)?.percent ?? 0} className="w-16 h-1.5" />
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {Math.round((geometryProgress ?? metadataProgress ?? progress)?.percent ?? 0)}%
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <span className="text-[10px] text-destructive mr-1 truncate max-w-24 flex-shrink-0">{error}</span>
      )}

      {/* Overflow menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-9 w-9 flex-shrink-0"
            aria-label={t('shellChrome.mobileToolbar.moreActionsAriaLabel')}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 max-h-[80vh] overflow-y-auto">
          {/* Walk Mode */}
          <DropdownMenuCheckboxItem
            checked={activeTool === 'walk'}
            onCheckedChange={() => setActiveTool(activeTool === 'walk' ? 'select' : 'walk')}
          >
            <PersonStanding className="h-4 w-4 mr-2" />
            {t('shellChrome.mobileToolbar.walkMode')}
          </DropdownMenuCheckboxItem>

          <DropdownMenuSeparator />

          {/* Visibility */}
          <DropdownMenuItem onClick={handleIsolate}>
            <Eye className="h-4 w-4 mr-2" />
            {t('shellChrome.mobileToolbar.isolateSelection')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleHide} disabled={!hasSelection}>
            <EyeOff className="h-4 w-4 mr-2" />
            {t('shellChrome.mobileToolbar.hideSelection')}
          </DropdownMenuItem>
          {hasSelection && (
            <DropdownMenuItem onClick={() => cameraCallbacks.frameSelection?.()}>
              <Crosshair className="h-4 w-4 mr-2" />
              {t('shellChrome.mobileToolbar.frameSelection')}
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          {/* Camera */}
          <DropdownMenuItem onClick={() => toggleProjectionMode()}>
            <Orbit className="h-4 w-4 mr-2" />
            {t(projectionMode === 'orthographic' ? 'shellChrome.mobileToolbar.perspective' : 'shellChrome.mobileToolbar.orthographic')}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* Export: the registry's rows, same as the command palette. Inline
              rather than a submenu: a nested Radix submenu closes as a touch
              leaves its trigger, so its rows could not be tapped on a phone. */}
          <DropdownMenuLabel data-mobile-export-menu className="flex items-center text-xs text-muted-foreground">
            <Download className="h-3.5 w-3.5 mr-2" />
            {t('shellChrome.mobileToolbar.export')}
          </DropdownMenuLabel>
          {exportRows.map((row) => (
            <DropdownMenuItem key={row.id} data-export-row={row.id} onClick={row.action}>
              <row.icon className="h-4 w-4 mr-2" />
              {row.labelKey ? t(row.labelKey, row.labelKeyParams) : row.label}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />

          {/* Theme */}
          <DropdownMenuItem onClick={() => toggleTheme()}>
            {theme === 'dark' ? <Sun className="h-4 w-4 mr-2" /> : <Moon className="h-4 w-4 mr-2" />}
            {t(theme === 'dark' ? 'shellChrome.mobileToolbar.lightMode' : 'shellChrome.mobileToolbar.darkMode')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {exportDialog}
    </div>
  );
}
