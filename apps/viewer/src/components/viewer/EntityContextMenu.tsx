/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Context menu for entity interactions
 */

import { ACTION_NAME_KEYS } from '@/lib/commands/action-names';
import { useCallback, useEffect, useLayoutEffect, useRef, useMemo, useState } from 'react';
import {
  Equal,
  Plus,
  Minus,
  EyeOff,
  Eye,
  Layers,
  Copy,
  Maximize2,
  Building2,
  Save,
  Trash2,
  ShieldQuestion,
} from 'lucide-react';
import { useViewerStore, resolveEntityRef, resolveGlobalId, toGlobalIdFromModels } from '@/store';
import type { DuplicateDirection } from '@/store/slices/mutationSlice';
import { useContextMutationAccess } from './useContextMutationAccess';
import { effectiveTreeEntityName } from './hierarchy/effectiveTypeEntities';
import { effectiveRowType } from './hierarchy/treeOverlay';
import { normalizeMutationModelId } from '@/sdk/adapters/mutation-view';
import { resetVisibilityForHomeFromStore } from '@/store/homeView';
import { hideFromContextMenuFromStore } from '@/store/hideSelection';
import {
  executeBasketSet,
  executeBasketAdd,
  executeBasketRemove,
  executeBasketSaveView,
} from '@/store/basket/basketCommands';
import { useIfc } from '@/hooks/useIfc';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import {
  ContextMenu, ContextMenuContent, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { DuplicateItems, ExtensionContextItems, MenuItem } from './EntityContextMenuItems';

export function EntityContextMenu() {
  const { t } = useTranslation();
  const contextMenu = useViewerStore((s) => s.contextMenu);
  const closeContextMenu = useViewerStore((s) => s.closeContextMenu);
  const hideEntity = useViewerStore((s) => s.hideEntity);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const setSelectedEntityIds = useViewerStore((s) => s.setSelectedEntityIds);
  const setAnonymizedExportRequested = useViewerStore((s) => s.setAnonymizedExportRequested);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  // Store-level mutations
  const removeEntity = useViewerStore((s) => s.removeEntity);
  const duplicateEntity = useViewerStore((s) => s.duplicateEntity);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [radixOpen, setRadixOpen] = useState(false);
  const { ifcDataStore, models } = useIfc();

  // Resolve contextMenu.entityId (globalId) to original expressId/model (IfcDataStore uses original expressIds, not globalIds).
  const { resolvedExpressId, activeDataStore, contextEntityRef } = useMemo(() => {
    if (!contextMenu.entityId) {
      return { resolvedExpressId: null, activeDataStore: ifcDataStore, contextEntityRef: null };
    }

    // Single source of truth for globalId → EntityRef resolution
    const ref = resolveEntityRef(contextMenu.entityId);
    if (ref) {
      const model = models.get(ref.modelId);
      return {
        resolvedExpressId: ref.expressId,
        activeDataStore: model?.ifcDataStore ?? ifcDataStore,
        contextEntityRef: ref,
      };
    }

    return {
      resolvedExpressId: contextMenu.entityId,
      activeDataStore: ifcDataStore,
      contextEntityRef: null,
    };
  }, [contextMenu.entityId, models, ifcDataStore]);

  // The viewport owns picking and opens the store menu after identifying the
  // right-clicked entity. Dispatch that same pointer position through Radix's
  // Trigger so its virtual anchor, focus management, and collision handling
  // remain authoritative. Root stays mounted for its close/focus lifecycle.
  useLayoutEffect(() => {
    if (!contextMenu.isOpen) {
      wasOpenRef.current = false;
      setRadixOpen(false);
      return;
    }
    if (!wasOpenRef.current) {
      focusReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    wasOpenRef.current = true;
    triggerRef.current?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: contextMenu.screenX,
      clientY: contextMenu.screenY,
    }));
  }, [contextMenu.isOpen, contextMenu.screenX, contextMenu.screenY]);

  // The pointer/keyboard outside dismissal belongs to Radix. Keep the scene
  // movement guards: a wheel or viewport resize invalidates the anchor.
  useEffect(() => {
    if (!contextMenu.isOpen) return;
    const handleDismiss = () => closeContextMenu();
    window.addEventListener('resize', handleDismiss);
    window.addEventListener('wheel', handleDismiss, { passive: true });
    return () => {
      window.removeEventListener('resize', handleDismiss);
      window.removeEventListener('wheel', handleDismiss);
    };
  }, [contextMenu.isOpen, closeContextMenu]);

  // Frame like F/search do (#5597): drop the multi-selection `frameSelection` prefers; defer so Viewport's refs catch up.
  const handleFrameSelection = useCallback(() => {
    if (contextMenu.entityId) {
      setSelectedEntityIds([]);
      setSelectedEntityId(contextMenu.entityId);
      if (cameraCallbacks.frameSelection) window.setTimeout(() => cameraCallbacks.frameSelection?.(), 50);
    }
    closeContextMenu();
  }, [contextMenu.entityId, setSelectedEntityIds, setSelectedEntityId, cameraCallbacks, closeContextMenu]);

  // Basket: = Set basket to this entity
  const handleSetBasket = useCallback(() => {
    executeBasketSet(contextEntityRef);
    closeContextMenu();
  }, [contextEntityRef, closeContextMenu]);

  // Basket: + Add to basket
  const handleAddToBasket = useCallback(() => {
    executeBasketAdd(contextEntityRef);
    closeContextMenu();
  }, [contextEntityRef, closeContextMenu]);

  // Basket: − Remove from basket
  const handleRemoveFromBasket = useCallback(() => {
    executeBasketRemove(contextEntityRef);
    closeContextMenu();
  }, [contextEntityRef, closeContextMenu]);

  const handleSaveBasketView = useCallback(() => {
    const state = useViewerStore.getState();
    if (state.pinboardEntities.size === 0) {
      closeContextMenu();
      return;
    }
    executeBasketSaveView().catch((err) => {
      console.error('[EntityContextMenu] Failed to save basket view:', err);
    });
    closeContextMenu();
  }, [closeContextMenu]);

  const handleHide = useCallback(() => {
    if (contextMenu.entityId) hideFromContextMenuFromStore(contextMenu.entityId);
    closeContextMenu();
  }, [contextMenu.entityId, closeContextMenu]);

  const handleShowAll = useCallback(() => {
    resetVisibilityForHomeFromStore('show_all');
    closeContextMenu();
  }, [closeContextMenu]);

  const handleSelectSimilar = useCallback(() => {
    // Use resolvedExpressId (original ID) for IfcDataStore lookups
    if (!resolvedExpressId || !activeDataStore) {
      closeContextMenu();
      return;
    }

    // Get the type of the selected entity
    const entity = activeDataStore.entities;
    let entityType: string | null = null;

    for (let i = 0; i < entity.count; i++) {
      if (entity.expressId[i] === resolvedExpressId) {
        entityType = entity.getTypeName(resolvedExpressId);
        break;
      }
    }

    if (entityType && contextEntityRef) {
      // `entity.expressId` is model-space — resolve through the model
      // offset before it reaches `selectedEntityIds` (renderer-space).
      const sameTypeIds: number[] = [];
      for (let i = 0; i < entity.count; i++) {
        if (entity.getTypeName(entity.expressId[i]) === entityType) {
          sameTypeIds.push(toGlobalIdFromModels(models, contextEntityRef.modelId, entity.expressId[i]));
        }
      }
      setSelectedEntityIds(sameTypeIds);
    }

    closeContextMenu();
  }, [resolvedExpressId, activeDataStore, contextEntityRef, models, setSelectedEntityIds, closeContextMenu]);

  const handleSelectSameStorey = useCallback(() => {
    // Use resolvedExpressId (original ID) for IfcDataStore lookups
    if (!resolvedExpressId || !activeDataStore?.spatialHierarchy) {
      closeContextMenu();
      return;
    }

    const storeyId = activeDataStore.spatialHierarchy.elementToStorey.get(resolvedExpressId);
    if (storeyId && contextEntityRef) {
      const storeyElements = activeDataStore.spatialHierarchy.byStorey.get(storeyId);
      if (storeyElements) {
        // Same model-space -> renderer-space resolution as above.
        setSelectedEntityIds(
          Array.from(storeyElements, (id) => toGlobalIdFromModels(models, contextEntityRef.modelId, id)),
        );
      }
    }

    closeContextMenu();
  }, [resolvedExpressId, activeDataStore, contextEntityRef, models, setSelectedEntityIds, closeContextMenu]);

  // "Export anonymized…" (#2934): seed `AnonymizedExportDialog` — whose
  // `useAnonymizedExportSet` reads `selectedEntityIds`, the multi-select
  // GLOBAL-id set, not the scalar (AGENTS.md "Selection has two channels") —
  // then flip the store flag the dialog (mounted trigger-less in
  // ViewerLayout.tsx) watches. Right-clicking inside an existing
  // multi-selection keeps it as the seed set (like `handleSetBasket`);
  // outside it, replace the selection with just this entity, as a left-click would.
  const handleExportAnonymized = useCallback(() => {
    const id = contextMenu.entityId;
    if (id !== null && !useViewerStore.getState().selectedEntityIds.has(id)) {
      setSelectedEntityIds([id]);
    }
    setAnonymizedExportRequested(true);
    closeContextMenu();
  }, [contextMenu.entityId, setSelectedEntityIds, setAnonymizedExportRequested, closeContextMenu]);

  const handleCopyId = useCallback(() => {
    if (contextMenu.entityId !== null) {
      const globalId = resolveGlobalId(contextMenu.entityId);
      if (globalId) void navigator.clipboard.writeText(globalId);
    }
    closeContextMenu();
  }, [contextMenu.entityId, closeContextMenu]);

  // Right-clicked entity's name and class for the header and toasts, read
  // through the session's mutation view so an element authored this session
  // shows its own name and class, not the parsed table's 'Unknown' (#6233).
  let entityName = '';
  let entityType = '';
  if (resolvedExpressId && activeDataStore) {
    const view = contextEntityRef
      ? mutationViews.get(normalizeMutationModelId(useViewerStore.getState(), contextEntityRef.modelId)) : undefined;
    entityName = effectiveTreeEntityName(activeDataStore, view, resolvedExpressId, '');
    entityType = effectiveRowType(activeDataStore, view, resolvedExpressId)
      ?? (activeDataStore.entities.getTypeName(resolvedExpressId) || '');
  }

  const { canEdit, editReasonKey, showMutationActions } = useContextMutationAccess(contextEntityRef, contextMenu.isOpen);
  const editReason = editReasonKey ? t(editReasonKey) : undefined;

  const handleDuplicate = useCallback(
    (direction: DuplicateDirection = '+X') => {
      if (!contextEntityRef || !canEdit) {
        closeContextMenu();
        return;
      }
      const result = duplicateEntity(contextEntityRef.modelId, contextEntityRef.expressId, direction);
      if ('error' in result) {
        toast.error(`Couldn't duplicate: ${result.error}`);
      } else {
        // Move selection onto the new entity so the property panel refreshes
        // and the user can keep iterating (Cmd+D again duplicates the duplicate, like a stamp tool).
        setSelectedEntityId(result.globalId);
        toast.success(`Duplicated as #${result.expressId} (${direction}) — undo to remove`);
      }
      closeContextMenu();
    },
    [contextEntityRef, canEdit, duplicateEntity, setSelectedEntityId, closeContextMenu],
  );

  const handleDeleteEntity = useCallback(() => {
    if (!contextEntityRef || !canEdit || !contextMenu.entityId) {
      closeContextMenu();
      return;
    }
    const ok = removeEntity(contextEntityRef.modelId, contextEntityRef.expressId);
    if (ok) {
      // Tombstoning only affects export — the mesh is still in the GPU buffers.
      // Hide it via the existing visibility system so it disappears from the scene
      // and stops being pickable. `Show all` (empty-space menu) restores it, with undo bringing back the overlay.
      hideEntity(contextMenu.entityId);
      // Drop the selection so the right panel doesn't cling to a tombstoned id.
      setSelectedEntityId(null);
      toast.success(`${entityType || 'Entity'} #${contextEntityRef.expressId} deleted — undo to restore`);
    } else {
      toast.error('Delete failed — entity not found in store overlay');
    }
    closeContextMenu();
  }, [contextEntityRef, canEdit, entityType, contextMenu.entityId, removeEntity, hideEntity, setSelectedEntityId, closeContextMenu]);

  return (
    <ContextMenu
      open={contextMenu.isOpen && radixOpen}
      modal={false}
      onOpenChange={(open) => {
        setRadixOpen(open);
        if (!open) closeContextMenu();
      }}
    >
      <ContextMenuTrigger
        ref={triggerRef}
        aria-hidden="true"
        className="pointer-events-none fixed h-px w-px"
        style={{ left: -1, top: -1 }}
      />
      <ContextMenuContent
        aria-label={contextMenu.entityId == null ? t('entityContextMenu.canvasActions') : t('entityContextMenu.entityActions')}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusReturnRef.current?.focus();
        }}
      >
      {contextMenu.entityId && (
        <>
          {/* Entity Header */}
          <div className="px-3 py-2 border-b">
            <div className="font-medium text-sm truncate">
              {entityName || `${entityType} #${contextMenu.entityId}`}
            </div>
            <div className="text-xs text-muted-foreground">{entityType}</div>
          </div>

          <MenuItem icon={Maximize2} label={t('entityContextMenu.frameSelection')} shortcut="camera.frameSelection" onClick={handleFrameSelection} />
          <MenuItem icon={EyeOff} label={t('entityContextMenu.hide')} shortcut="visibility.hideSelection" onClick={handleHide} />

          <ContextMenuSeparator />

          {/* Basket operations */}
          <MenuItem icon={Equal} label={t('entityContextMenu.setBasket')} shortcut="basket.set" onClick={handleSetBasket} />
          <MenuItem icon={Plus} label={t('entityContextMenu.addToBasket')} shortcut="basket.add" onClick={handleAddToBasket} />
          <MenuItem icon={Minus} label={t('entityContextMenu.removeFromBasket')} shortcut="basket.remove" onClick={handleRemoveFromBasket} />
          <MenuItem icon={Save} label={t('entityContextMenu.saveBasketView')} shortcut="basket.saveView" onClick={handleSaveBasketView} />

          <ContextMenuSeparator />

          <MenuItem icon={Layers} label={`Select all ${entityType}`} onClick={handleSelectSimilar} />
          <MenuItem icon={Building2} label="Select same storey" onClick={handleSelectSameStorey} />

          <ContextMenuSeparator />

          <MenuItem icon={Copy} label={t(ACTION_NAME_KEYS.copyGlobalId)} onClick={handleCopyId} />
          <MenuItem icon={ShieldQuestion} label="Export anonymized…" onClick={handleExportAnonymized} />

          {/* Keep denied actions visible with their reason; an editable view
              is created on demand when the menu opens in Edit mode. */}
          {showMutationActions && (
            <>
              <ContextMenuSeparator />
              <DuplicateItems onDuplicate={handleDuplicate} disabled={!canEdit} reason={editReason} />
              <MenuItem
                icon={Trash2}
                label="Delete entity"
                tone="destructive"
                disabled={!canEdit}
                title={editReason}
                onClick={handleDeleteEntity}
              />
            </>
          )}
        </>
      )}

      {!contextMenu.entityId && (
        <MenuItem icon={Eye} label={t(ACTION_NAME_KEYS.showAll)} shortcut="visibility.showAll" onClick={handleShowAll} />
      )}

      <ExtensionContextItems
        slot={contextMenu.entityId != null ? 'contextMenu.entity' : 'contextMenu.canvas'}
        hasEntity={contextMenu.entityId != null}
      />
      </ContextMenuContent>
    </ContextMenu>
  );
}
