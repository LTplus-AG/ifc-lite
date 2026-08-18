/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Global keyboard shortcuts for the viewer
 */

import { useEffect, useCallback, useRef } from 'react';
import { useViewerStore } from '@/store';
import { resetVisibilityForHomeFromStore } from '@/store/homeView';
import { workspacePanelForShortcutCode } from '@/lib/panels/registry';
import { closeAllPanelWindows } from '@/services/panel-windows';
import { eventKey, isTextEntryTarget } from '@/lib/keyboard-event';
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
  // Polyline (multi-click) mode (#2199).
  const activePolyline = useViewerStore((s) => s.activePolyline);
  const cancelPolyline = useViewerStore((s) => s.cancelPolyline);
  // Angle (fixed-count multi-click) mode (#2735).
  const activeAngle = useViewerStore((s) => s.activeAngle);
  const cancelAngle = useViewerStore((s) => s.cancelAngle);
  const finishPolyline = useViewerStore((s) => s.finishPolyline);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Ignore if typing in an input or textarea
    if (isTextEntryTarget(e)) {
      return;
    }

    // Get modifier keys
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    // Browsers may dispatch a key event with no `key` (autofill, synthetic
    // events) — see lib/keyboard-event.ts. No shortcut below could match one.
    const key = eventKey(e);
    if (key === null) return;

    // Undo / Redo — Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, scoped to the
    // active model's mutation stack. Always available regardless
    // of edit mode so the user can recover from any change.
    if (key === 'z' && ctrl) {
      e.preventDefault();
      const state = useViewerStore.getState();
      const activeModelId = state.activeModelId;
      if (!activeModelId) return;
      if (shift) state.redo(activeModelId);
      else state.undo(activeModelId);
      return;
    }

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

    // Alt+1..9 / Alt+0 — jump to a workspace panel in its home region (#1200/#1208).
    // Uses e.code so it works regardless of the Alt character a layout produces
    // (Alt+1 = ¡ on macOS). 1-9 map to the first nine; 0 maps to the tenth.
    if (e.altKey && !ctrl) {
      const shortcutPanel = workspacePanelForShortcutCode(e.code);
      if (shortcutPanel) {
        e.preventDefault();
        useViewerStore.getState().openPanelInHome(shortcutPanel);
        return;
      }
      // Alt+\\ — toggle the sidebar (expand ⇄ collapse to icons; the rail stays).
      if (e.code === 'Backslash') {
        e.preventDefault();
        useViewerStore.getState().cycleSidebarMode();
        return;
      }
    }

    // Global edit-mode pill — unlocks inline property/attribute
    // editors, add-element draw tools, georeference placement, and
    // future geometry manipulators. Toggle from anywhere outside an
    // input field.
    if (key === 'e' && !ctrl && !shift) {
      e.preventDefault();
      toggleEditEnabled();
    }

    // K = knife / Split. Operates only on the currently selected
    // entity — there's no free-roam "hover anything and split" mode
    // any more. If there's no selection, the keypress is a no-op
    // (a toast would be noisy; the user can see no entity is
    // selected). The action also pre-arms the splitTarget so the
    // overlay knows what to draw the moment Split engages.
    if (key === 'k' && !ctrl && !shift) {
      e.preventDefault();
      const state = useViewerStore.getState();
      if (state.activeTool === 'split') {
        state.clearSplitHover();
        state.setActiveTool('select');
        return;
      }
      const sel = state.selectedEntity;
      if (!sel) return;
      state.setSplitTarget(sel.modelId, sel.expressId);
      state.setActiveTool('split');
    }

    // R / Shift+R = rotate selected entity ±15° about the storey-up
    // Z axis. Only fires while edit mode is on and a single entity
    // is selected. The rotateEntity action handles the placement
    // chain walk + undo registration.
    if (key === 'r' && !ctrl) {
      const state = useViewerStore.getState();
      if (state.editEnabled && state.selectedEntity) {
        e.preventDefault();
        const deltaDeg = shift ? -15 : 15;
        const result = state.rotateEntity(
          state.selectedEntity.modelId,
          state.selectedEntity.expressId,
          (deltaDeg * Math.PI) / 180,
        );
        if (!result.ok) {
          // Surface the reason via the existing toast helper rather
          // than a console warning — the user just pressed a key and
          // deserves immediate feedback.
          void import('@/components/ui/toast').then((m) => {
            m.toast.error(`Couldn't rotate: ${result.reason}`);
          });
        }
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

    // Split tool — Esc exits Split and returns to Select. We catch
    // it here before the global Esc handler so the user gets a
    // gentle exit (clear hover, swap tool) rather than the global
    // "clear all selection + visibility" cascade.
    if (activeTool === 'split' && key === 'escape') {
      e.preventDefault();
      const state = useViewerStore.getState();
      state.clearSplitHover();
      state.setActiveTool('select');
      return;
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
      // Cancel active drag measurement with ESC
      if (key === 'escape' && activeMeasurement) {
        e.preventDefault();
        cancelMeasurement();
        return;
      }
      // Cancel an in-progress polyline sequence with ESC (#2199) — discards
      // it entirely, same as Escape already does for a drag in progress.
      // Checked as its own branch (not merged with the one above) because
      // the two are mutually exclusive: exactly one of activeMeasurement /
      // activePolyline can be non-null at a time.
      if (key === 'escape' && activePolyline) {
        e.preventDefault();
        cancelPolyline();
        return;
      }
      // Same for a part-finished angle sequence (#2735). Its own branch for
      // the same reason: at most one of activeMeasurement / activePolyline /
      // activeAngle is non-null at a time, and merging them would hide that.
      // No Enter counterpart - an angle finishes itself on its last pick, so
      // there is no "finish early" state to confirm.
      if (key === 'escape' && activeAngle) {
        e.preventDefault();
        cancelAngle();
        return;
      }
      // Finish an in-progress polyline as OPEN with Enter (#2199) — reports
      // the sum-of-segments length, not a perimeter. Closing the loop is a
      // click gesture, not a keyboard one (see handlePolylineClick).
      //
      // finishPolyline is a no-op below its point minimum (2 open / 3
      // closed) — most reachable right after a single click, since Enter
      // can't fire before startPolyline runs. Its return value says whether
      // it actually recorded anything; when it didn't, surface a toast
      // instead of leaving Enter a silent, indistinguishable-from-working
      // dead keypress. The sequence itself is left in progress (not
      // cancelled) — same "reject and let the user keep going" choice
      // `commitAddElementSlabPolygon` above makes for the analogous
      // too-few-points case.
      if (key === 'enter' && activePolyline) {
        e.preventDefault();
        if (!finishPolyline(false)) {
          // Lazy import keeps toast out of the keyboard hook's synchronous
          // bundle, same as the addElement branch above.
          import('@/components/ui/toast').then(({ toast }) => {
            toast.error('Polyline needs at least 2 points');
          });
        }
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
        // Double-escape: close all panels, return to starting view.
        const state = useViewerStore.getState();
        // Clears every sidebar panel through the choke point (bcf/ids/lens/
        // clash/compare/extensions → Information). Bottom panels + overlays
        // are closed explicitly.
        state.showWorkspacePanel('properties');
        // Floats + popped-out OS windows are their own channel; the choke point
        // above only re-docks `properties`, so drop every float and close every
        // torn-off window so "close all" truly closes all (#1208).
        state.resetDockLayout();
        closeAllPanelWindows();
        state.setScriptPanelVisible(false);
        state.setListPanelVisible(false);
        state.setGanttPanelVisible(false);
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
    activePolyline, activeAngle, cancelAngle,
    cancelPolyline,
    finishPolyline,
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
  { key: 'Ctrl+Z / Cmd+Z', description: 'Undo last authoring change for the active model', category: 'Editing' },
  { key: 'Ctrl+Shift+Z / Cmd+Shift+Z', description: 'Redo last undone change', category: 'Editing' },
  { key: 'V', description: 'Select tool', category: 'Tools' },
  { key: 'C', description: 'Walk mode', category: 'Tools' },
  { key: 'M', description: 'Measure tool', category: 'Tools' },
  { key: 'P', description: 'Annotate tool — drop a pin with a note', category: 'Tools' },
  { key: 'X', description: 'Section tool', category: 'Tools' },
  { key: 'E', description: 'Toggle edit mode (unlocks property + geometry edits)', category: 'Tools' },
  { key: 'K', description: 'Split the selected entity (requires a selection)', category: 'Tools' },
  { key: 'R / Shift+R', description: 'Rotate selected entity ±15° about Z (requires edit mode)', category: 'Tools' },
  { key: 'S', description: 'Toggle snapping (Measure tool)', category: 'Tools' },
  { key: 'Esc', description: 'Cancel measurement (Measure tool)', category: 'Tools' },
  { key: 'Enter', description: 'Finish polyline as open length (Measure tool, polyline mode)', category: 'Tools' },
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
  { key: 'Alt+1…0', description: 'Open a panel from the rail (Info, Compare, BCF, IDS, Lens, Clash, Extensions; Script, Schedule, Lists open at the bottom)', category: 'UI' },
  { key: 'Alt+\\', description: 'Toggle sidebar (expand ⇄ collapse to icons)', category: 'UI' },
  { key: 'Esc', description: 'Reset all (clear selection, basket, isolation)', category: 'Selection' },
  { key: 'Esc Esc', description: 'Close all panels (return to starting view)', category: 'UI' },
  { key: 'Ctrl+K', description: 'Command palette', category: 'UI' },
  { key: '?', description: 'Show info panel', category: 'Help' },
] as const;
