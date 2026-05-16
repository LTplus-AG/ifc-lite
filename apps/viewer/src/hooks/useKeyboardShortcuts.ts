/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Global keyboard shortcuts for the viewer
 */

import { useEffect, useCallback, useRef } from 'react';
import { useViewerStore } from '@/store';
import { resetVisibilityForHomeFromStore } from '@/store/homeView';
import {
  executeBasketIsolate,
  executeBasketSet,
  executeBasketAdd,
  executeBasketRemove,
  executeBasketSaveView,
} from '@/store/basket/basketCommands';

interface KeyboardShortcutsOptions {
  enabled?: boolean;
}

/** Get all selected global IDs — multi-select if available, else single selectedEntityId */
function getAllSelectedGlobalIds(): number[] {
  const state = useViewerStore.getState();
  if (state.selectedEntityIds.size > 0) {
    return Array.from(state.selectedEntityIds);
  }
  if (state.selectedEntityId !== null) {
    return [state.selectedEntityId];
  }
  return [];
}

/** Double-escape threshold in milliseconds */
const DOUBLE_ESCAPE_MS = 500;

export function useKeyboardShortcuts(options: KeyboardShortcutsOptions = {}) {
  const { enabled = true } = options;

  const lastEscapeRef = useRef<number>(0);

  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const activeTool = useViewerStore((s) => s.activeTool);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const hideEntities = useViewerStore((s) => s.hideEntities);
  const toggleTheme = useViewerStore((s) => s.toggleTheme);
  const toggleBasketPresentationVisible = useViewerStore((s) => s.toggleBasketPresentationVisible);
  const toggleEditEnabled = useViewerStore((s) => s.toggleEditEnabled);

  // Measure tool specific actions
  const activeMeasurement = useViewerStore((s) => s.activeMeasurement);
  const cancelMeasurement = useViewerStore((s) => s.cancelMeasurement);
  const clearMeasurements = useViewerStore((s) => s.clearMeasurements);
  const toggleSnap = useViewerStore((s) => s.toggleSnap);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Ignore if typing in an input or textarea
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    ) {
      return;
    }

    // Get modifier keys
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const key = e.key.toLowerCase();

    // Navigation tools
    if (key === 'v' && !ctrl && !shift) {
      e.preventDefault();
      setActiveTool('select');
    }
    if (key === 'c' && !ctrl && !shift) {
      e.preventDefault();
      setActiveTool('walk');
    }
    if (key === 'm' && !ctrl && !shift) {
      e.preventDefault();
      setActiveTool('measure');
    }
    if (key === 'x' && !ctrl && !shift) {
      e.preventDefault();
      setActiveTool('section');
    }
    if (key === 'p' && !ctrl && !shift) {
      e.preventDefault();
      setActiveTool('annotate');
    }

    // Global edit-mode pill — unlocks inline property/attribute
    // editors, add-element draw tools, georeference placement, and
    // future geometry manipulators. Toggle from anywhere outside an
    // input field.
    if (key === 'e' && !ctrl && !shift) {
      e.preventDefault();
      toggleEditEnabled();
    }

    // W = wall draw tool. Only fires while edit mode is on so casual
    // viewers never accidentally enter an authoring tool. The
    // implementation reuses the existing addElement state machine
    // (see `addElementSlice` and `AddElementOverlay`).
    if (key === 'w' && !ctrl && !shift) {
      const state = useViewerStore.getState();
      if (state.editEnabled) {
        e.preventDefault();
        state.setAddElementType('wall');
        state.setActiveTool('addElement');
      }
    }

    // Basket controls (automatic context source)
    // I = Isolate from current context
    if (key === 'i' && !ctrl && !shift) {
      e.preventDefault();
      executeBasketIsolate();
    }

    // = Set basket from active context
    if (e.key === '=' && !ctrl && !shift) {
      e.preventDefault();
      executeBasketSet();
    }

    // + Add active context to basket
    if ((e.key === '+' || (e.key === '=' && shift)) && !ctrl) {
      e.preventDefault();
      executeBasketAdd();
    }

    // - Remove active context from basket
    if ((e.key === '-' || e.key === '_') && !ctrl) {
      e.preventDefault();
      executeBasketRemove();
    }

    // D Toggle basket presentation dock
    if (key === 'd' && !ctrl && !shift) {
      e.preventDefault();
      toggleBasketPresentationVisible();
    }

    // B Save current basket as presentation view with thumbnail
    if (key === 'b' && !ctrl && !shift) {
      const state = useViewerStore.getState();
      if (state.pinboardEntities.size > 0) {
        e.preventDefault();
        executeBasketSaveView().catch((err) => {
          console.error('[useKeyboardShortcuts] Failed to save basket view:', err);
        });
      }
    }

    if ((key === 'delete' || key === 'backspace') && !ctrl && !shift && selectedEntityId) {
      e.preventDefault();
      const ids = getAllSelectedGlobalIds();
      hideEntities(ids);
    }
    // Space to hide — skip when focused on buttons/selects/links where Space has native behavior
    if (key === ' ' && !ctrl && !shift && selectedEntityId) {
      const tag = document.activeElement?.tagName;
      if (tag !== 'BUTTON' && tag !== 'SELECT' && tag !== 'A') {
        e.preventDefault();
        const ids = getAllSelectedGlobalIds();
        hideEntities(ids);
      }
    }
    if (key === 'a' && !ctrl && !shift) {
      e.preventDefault();
      resetVisibilityForHomeFromStore();
    }

    // Add-element tool shortcuts — Enter commits an in-progress slab
    // polygon; Esc clears any pending points before falling through to
    // the global Esc handler (which exits the tool).
    if (activeTool === 'addElement') {
      const state = useViewerStore.getState();
      const polygonable = ['slab', 'roof', 'plate', 'space'].includes(state.addElementType);
      if (key === 'enter' && polygonable && state.addElementSlabMode === 'polygon') {
        e.preventDefault();
        // Lazy import keeps this module out of the keyboard hook's
        // synchronous bundle (the close handler pulls in toast).
        import('@/components/viewer/selectionHandlers').then((mod) => mod.commitAddElementSlabPolygon());
        return;
      }
      if (key === 'escape' && state.addElementPendingPoints.length > 0) {
        e.preventDefault();
        state.clearAddElementPending();
        return;
      }
    }

    // Measure tool shortcuts
    if (activeTool === 'measure') {
      // Cancel active measurement with ESC
      if (key === 'escape' && activeMeasurement) {
        e.preventDefault();
        cancelMeasurement();
        return;
      }
      // Clear all measurements with Ctrl+C or Cmd+C
      if (key === 'c' && ctrl && !shift) {
        e.preventDefault();
        clearMeasurements();
        return;
      }
      // Toggle snapping with S
      if (key === 's' && !ctrl && !shift) {
        e.preventDefault();
        toggleSnap();
        return;
      }
      // Delete/Backspace clears measurements (when nothing is selected)
      if ((key === 'delete' || key === 'backspace') && !ctrl && !shift && !selectedEntityId) {
        e.preventDefault();
        clearMeasurements();
        return;
      }
    }

    // Escape: first press clears selection/tool, double-press closes all panels
    if (key === 'escape') {
      e.preventDefault();
      const now = Date.now();
      const timeSinceLastEscape = now - lastEscapeRef.current;
      lastEscapeRef.current = now;

      if (timeSinceLastEscape < DOUBLE_ESCAPE_MS) {
        // Double-escape: close all panels, return to starting view
        const state = useViewerStore.getState();
        state.setBcfPanelVisible(false);
        state.setIdsPanelVisible(false);
        state.setLensPanelVisible(false);
        state.setScriptPanelVisible(false);
        state.setListPanelVisible(false);
        state.setDrawing2DPanelVisible(false);
        state.setOverridesPanelVisible(false);
        state.setChatPanelVisible(false);
        state.setSheetPanelVisible(false);
        state.setLeftPanelCollapsed(false);
        state.setRightPanelCollapsed(false);
      }

      setSelectedEntityId(null);
      resetVisibilityForHomeFromStore();
      setActiveTool('select');
    }

    // Theme toggle
    if (key === 't' && !ctrl && !shift) {
      e.preventDefault();
      toggleTheme();
    }

    // Help - handled by KeyboardShortcutsDialog hook
    // The dialog hook listens for '?' key globally
  }, [
    selectedEntityId,
    setSelectedEntityId,
    activeTool,
    setActiveTool,
    hideEntities,
    toggleTheme,
    toggleBasketPresentationVisible,
    activeMeasurement,
    cancelMeasurement,
    clearMeasurements,
    toggleSnap,
    toggleEditEnabled,
  ]);

  useEffect(() => {
    if (!enabled) return;

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, handleKeyDown]);
}

// Export shortcut definitions for UI display
export const KEYBOARD_SHORTCUTS = [
  { key: 'V', description: 'Select tool', category: 'Tools' },
  { key: 'C', description: 'Walk mode', category: 'Tools' },
  { key: 'M', description: 'Measure tool', category: 'Tools' },
  { key: 'P', description: 'Annotate tool — drop a pin with a note', category: 'Tools' },
  { key: 'X', description: 'Section tool', category: 'Tools' },
  { key: 'E', description: 'Toggle edit mode (unlocks property + geometry edits)', category: 'Tools' },
  { key: 'W', description: 'Draw Wall (requires edit mode)', category: 'Tools' },
  { key: 'S', description: 'Toggle snapping (Measure tool)', category: 'Tools' },
  { key: 'Esc', description: 'Cancel measurement (Measure tool)', category: 'Tools' },
  { key: 'Ctrl+C', description: 'Clear measurements (Measure tool)', category: 'Tools' },
  { key: 'I', description: 'Isolate (set basket from current context)', category: 'Visibility' },
  { key: '=', description: 'Set basket from current context', category: 'Visibility' },
  { key: '+', description: 'Add current context to basket', category: 'Visibility' },
  { key: '−', description: 'Remove current context from basket', category: 'Visibility' },
  { key: 'D', description: 'Toggle basket presentation dock', category: 'Visibility' },
  { key: 'B', description: 'Save basket as presentation view', category: 'Visibility' },
  { key: 'Del / Space', description: 'Hide selection', category: 'Visibility' },
  { key: 'A', description: 'Show all (clear filters and basket)', category: 'Visibility' },
  { key: 'H', description: 'Home (isometric + reset visibility)', category: 'Camera' },
  { key: 'Z', description: 'Fit all (zoom extents)', category: 'Camera' },
  { key: 'F', description: 'Frame selection', category: 'Camera' },
  { key: '1-6', description: 'Preset views', category: 'Camera' },
  { key: 'T', description: 'Toggle theme', category: 'UI' },
  { key: 'Esc', description: 'Reset all (clear selection, basket, isolation)', category: 'Selection' },
  { key: 'Esc Esc', description: 'Close all panels (return to starting view)', category: 'UI' },
  { key: 'Ctrl+K', description: 'Command palette', category: 'UI' },
  { key: '?', description: 'Show info panel', category: 'Help' },
] as const;
