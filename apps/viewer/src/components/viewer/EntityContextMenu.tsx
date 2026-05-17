/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Context menu for entity interactions
 */

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
  CopyPlus,
} from 'lucide-react';
import { useViewerStore, resolveEntityRef } from '@/store';
import type { DuplicateDirection } from '@/store/slices/mutationSlice';
import { resetVisibilityForHomeFromStore } from '@/store/homeView';
import {
  executeBasketSet,
  executeBasketAdd,
  executeBasketRemove,
  executeBasketSaveView,
} from '@/store/basket/basketCommands';
import { useIfc } from '@/hooks/useIfc';
import { toast } from '@/components/ui/toast';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { evaluateWhen, parseWhen, type CommandContribution, type ResolvedContextMenuContribution } from '@ifc-lite/extensions';
import { resolveExtensionIcon } from '@/components/extensions/icon-registry';

export function EntityContextMenu() {
  const contextMenu = useViewerStore((s) => s.contextMenu);
  const closeContextMenu = useViewerStore((s) => s.closeContextMenu);
  const hideEntity = useViewerStore((s) => s.hideEntity);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const setSelectedEntityIds = useViewerStore((s) => s.setSelectedEntityIds);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  // Store-level mutations
  const removeEntity = useViewerStore((s) => s.removeEntity);
  const duplicateEntity = useViewerStore((s) => s.duplicateEntity);
  const getMutationView = useViewerStore((s) => s.getMutationView);
  // Basket actions
  const menuRef = useRef<HTMLDivElement>(null);
  const { ifcDataStore, models } = useIfc();

  // Resolve contextMenu.entityId (globalId) to original expressId and model
  // This is needed because IfcDataStore uses original expressIds, not globalIds
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

  // Close menu when clicking/tapping outside.
  //
  // Listen on `pointerdown` (with capture) rather than `mousedown`:
  // the canvas calls `e.preventDefault()` on its own pointerdown
  // handler, which in some browsers suppresses the compatibility
  // `mousedown` event — so a plain `mousedown` listener never fires
  // when the user clicks the 3D viewport to dismiss the menu.
  useEffect(() => {
    if (!contextMenu.isOpen) return;
    const handlePointerOutside = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };
    // Also close on scroll/resize — the anchor coords go stale.
    const handleDismiss = () => closeContextMenu();
    document.addEventListener('pointerdown', handlePointerOutside, true);
    window.addEventListener('resize', handleDismiss);
    window.addEventListener('wheel', handleDismiss, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', handlePointerOutside, true);
      window.removeEventListener('resize', handleDismiss);
      window.removeEventListener('wheel', handleDismiss);
    };
  }, [contextMenu.isOpen, closeContextMenu]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeContextMenu();
      }
    };

    if (contextMenu.isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [contextMenu.isOpen, closeContextMenu]);

  const handleZoomTo = useCallback(() => {
    if (contextMenu.entityId) {
      setSelectedEntityId(contextMenu.entityId);
      cameraCallbacks.fitAll?.();
    }
    closeContextMenu();
  }, [contextMenu.entityId, setSelectedEntityId, cameraCallbacks, closeContextMenu]);

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
    if (contextMenu.entityId) {
      hideEntity(contextMenu.entityId);
    }
    closeContextMenu();
  }, [contextMenu.entityId, hideEntity, closeContextMenu]);

  const handleShowAll = useCallback(() => {
    resetVisibilityForHomeFromStore();
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

    if (entityType) {
      // Select all entities of the same type
      // NOTE: These are original expressIds - for multi-model, should transform to globalIds
      const sameTypeIds: number[] = [];
      for (let i = 0; i < entity.count; i++) {
        if (entity.getTypeName(entity.expressId[i]) === entityType) {
          sameTypeIds.push(entity.expressId[i]);
        }
      }
      setSelectedEntityIds(sameTypeIds);
    }

    closeContextMenu();
  }, [resolvedExpressId, activeDataStore, setSelectedEntityIds, closeContextMenu]);

  const handleSelectSameStorey = useCallback(() => {
    // Use resolvedExpressId (original ID) for IfcDataStore lookups
    if (!resolvedExpressId || !activeDataStore?.spatialHierarchy) {
      closeContextMenu();
      return;
    }

    const storeyId = activeDataStore.spatialHierarchy.elementToStorey.get(resolvedExpressId);
    if (storeyId) {
      const storeyElements = activeDataStore.spatialHierarchy.byStorey.get(storeyId);
      if (storeyElements) {
        // NOTE: These are original expressIds - for multi-model, should transform to globalIds
        setSelectedEntityIds(Array.from(storeyElements));
      }
    }

    closeContextMenu();
  }, [resolvedExpressId, activeDataStore, setSelectedEntityIds, closeContextMenu]);

  const handleCopyId = useCallback(() => {
    // Use resolvedExpressId (original ID) for IfcDataStore lookups
    if (resolvedExpressId && activeDataStore) {
      const globalId = activeDataStore.entities.getGlobalId(resolvedExpressId);
      if (globalId) {
        navigator.clipboard.writeText(globalId);
      }
    }
    closeContextMenu();
  }, [resolvedExpressId, activeDataStore, closeContextMenu]);

  // Right-clicked entity's type — used in the toast message.
  const contextEntityType = useMemo(() => {
    if (!resolvedExpressId || !activeDataStore) return '';
    return activeDataStore.entities.getTypeName(resolvedExpressId) || '';
  }, [resolvedExpressId, activeDataStore]);

  // Mutation view is required to drive bim.store.* — native-metadata-only
  // models don't have one, so the Delete option stays hidden there.
  const canEdit = useMemo(() => {
    if (!contextEntityRef) return false;
    return getMutationView(contextEntityRef.modelId) !== null;
  }, [contextEntityRef, getMutationView]);

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
        // Move selection onto the new entity so the property panel
        // refreshes and the user can keep iterating (Cmd+D again
        // duplicates the duplicate, like a stamp tool).
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
      // Tombstoning only affects export — the rendered mesh is still
      // in the GPU buffers. Hide it via the existing visibility system
      // so the entity disappears from the scene and stops being
      // pickable. `Show all` from the empty-space menu restores it
      // (along with re-running undo to bring back the overlay).
      hideEntity(contextMenu.entityId);
      // Drop the selection so the right panel doesn't cling to a
      // tombstoned id.
      setSelectedEntityId(null);
      toast.success(`${contextEntityType || 'Entity'} #${contextEntityRef.expressId} deleted — undo to restore`);
    } else {
      toast.error('Delete failed — entity not found in store overlay');
    }
    closeContextMenu();
  }, [contextEntityRef, canEdit, contextEntityType, contextMenu.entityId, removeEntity, hideEntity, setSelectedEntityId, closeContextMenu]);

  // Viewport-constrained placement (mirrors OS context-menu behaviour):
  // flip up/left when the menu would overflow the bottom/right edges,
  // then clamp against the opposite edge so it never crosses any side
  // of the viewport. Two-pass render: invisible first, then measure and
  // reposition before the browser paints (useLayoutEffect is sync).
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!contextMenu.isOpen) {
      setPosition(null);
      return;
    }
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const margin = 4;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const anchorX = contextMenu.screenX;
    const anchorY = contextMenu.screenY;

    // Horizontal: prefer right of cursor, flip to left if it would
    // overflow the right edge, then clamp.
    let left = anchorX;
    if (left + rect.width + margin > vw) {
      const flipped = anchorX - rect.width;
      left = flipped >= margin ? flipped : Math.max(margin, vw - rect.width - margin);
    }
    if (left < margin) left = margin;

    // Vertical: prefer below cursor, flip above if it would overflow
    // the bottom edge, then clamp.
    let top = anchorY;
    if (top + rect.height + margin > vh) {
      const flipped = anchorY - rect.height;
      top = flipped >= margin ? flipped : Math.max(margin, vh - rect.height - margin);
    }
    if (top < margin) top = margin;

    setPosition({ left, top });
  }, [contextMenu.isOpen, contextMenu.screenX, contextMenu.screenY, contextMenu.entityId]);

  if (!contextMenu.isOpen) {
    return null;
  }

  // Get entity info for display
  // Use resolvedExpressId (original ID) for IfcDataStore lookups
  let entityName = '';
  let entityType = '';
  if (resolvedExpressId && activeDataStore) {
    entityName = activeDataStore.entities.getName(resolvedExpressId) || '';
    entityType = activeDataStore.entities.getTypeName(resolvedExpressId) || '';
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-popover border rounded-lg shadow-lg py-1 min-w-48"
      style={{
        left: position?.left ?? contextMenu.screenX,
        top: position?.top ?? contextMenu.screenY,
        // Hide the first render: we need a measured rect to compute the
        // constrained position. `useLayoutEffect` resolves this before
        // paint, so the user never sees the unclamped flash.
        visibility: position ? 'visible' : 'hidden',
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

          <MenuItem icon={Maximize2} label="Zoom to" onClick={handleZoomTo} />
          <MenuItem icon={EyeOff} label="Hide" onClick={handleHide} />

          <div className="h-px bg-border my-1" />

          {/* Basket operations */}
          <MenuItem icon={Equal} label="Set Basket (=)" onClick={handleSetBasket} />
          <MenuItem icon={Plus} label="Add to Basket (+)" onClick={handleAddToBasket} />
          <MenuItem icon={Minus} label="Remove from Basket (−)" onClick={handleRemoveFromBasket} />
          <MenuItem icon={Save} label="Save Basket View (B)" onClick={handleSaveBasketView} />

          <div className="h-px bg-border my-1" />

          <MenuItem icon={Layers} label={`Select all ${entityType}`} onClick={handleSelectSimilar} />
          <MenuItem icon={Building2} label="Select same storey" onClick={handleSelectSameStorey} />

          <div className="h-px bg-border my-1" />

          <MenuItem icon={Copy} label="Copy GlobalId" onClick={handleCopyId} />

          {/* Store-level mutations (bim.store.*). Only surfaced when there's
              a live mutation view on the model — otherwise these would
              silently no-op and confuse users. */}
          {canEdit && (
            <>
              <div className="h-px bg-border my-1" />
              <DuplicateRow onDuplicate={handleDuplicate} />
              <MenuItem
                icon={Trash2}
                label="Delete entity"
                tone="destructive"
                onClick={handleDeleteEntity}
              />
            </>
          )}
        </>
      )}

      {!contextMenu.entityId && (
        <>
          <MenuItem icon={Eye} label="Show all" onClick={handleShowAll} />
        </>
      )}

      <ExtensionContextItems
        slot={contextMenu.entityId != null ? 'contextMenu.entity' : 'contextMenu.canvas'}
        hasEntity={contextMenu.entityId != null}
      />
    </div>
  );
}

/**
 * Renders extension-contributed entries for the entity or canvas
 * context-menu slot. Each contribution is `when`-filtered; clicking
 * dispatches the contributed command through the extension host.
 */
function ExtensionContextItems({
  slot,
  hasEntity,
}: {
  slot: 'contextMenu.entity' | 'contextMenu.canvas';
  hasEntity: boolean;
}) {
  // Loader enriches the contextMenu payload with icon + title from
  // the linked command (see manifestToContributions). Fall back to
  // the commandPalette lookup for title if a manifest somehow omits it.
  const contributions = useSlotContributions<ResolvedContextMenuContribution>(slot);
  const commandPalette = useSlotContributions<CommandContribution>('commandPalette');
  const host = useOptionalExtensionHost();
  const closeContextMenu = useViewerStore((s) => s.closeContextMenu);
  if (contributions.length === 0) return null;
  const whenContext = {
    'selection.count': hasEntity ? 1 : 0,
    'model.loaded': true,
  };
  const titleFor = (c: ResolvedContextMenuContribution): string => {
    if (c.title) return c.title;
    const found = commandPalette.find((cp) => cp.payload.id === c.command);
    return found?.payload.title ?? c.command;
  };
  const visible = contributions.filter((c) => {
    const when = c.payload.when;
    if (!when) return true;
    const parsed = parseWhen(when);
    if (!parsed.ok) return false;
    return evaluateWhen(parsed.value, whenContext);
  });
  if (visible.length === 0) return null;
  return (
    <>
      <div className="h-px bg-border my-1" />
      {visible.map((c) => {
        const Icon = resolveExtensionIcon(c.payload.icon);
        return (
          <MenuItem
            key={`${c.extensionId}:${c.payload.command}`}
            icon={Icon}
            label={titleFor(c.payload)}
            onClick={() => {
              closeContextMenu();
              host?.runCommand(c.payload.command).catch((err) => {
                toast.error(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
              });
            }}
          />
        );
      })}
    </>
  );
}

type MenuItemTone = 'default' | 'destructive';

interface MenuItemProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Right-aligned keyboard hint (e.g. `'⌘D'`). */
  shortcut?: string;
  /**
   * Visual tone:
   * - `default`     muted icon, neutral hover
   * - `destructive` red-toned icon and red-tinted hover (Delete entity)
   */
  tone?: MenuItemTone;
}

/**
 * Inline directional duplicate row — primary label on the left
 * (clickable, fires the default +X duplicate), six axis chips on
 * the right for explicit direction control. Mirrors the column
 * placement axes the user already sees on the Raw STEP tab.
 *
 * Why six chips and not a sub-menu: a flyout for six options is
 * wasted real estate, and the chip arrows let the user "see and
 * pick" in one motion.
 */
function DuplicateRow({ onDuplicate }: { onDuplicate: (dir: DuplicateDirection) => void }) {
  return (
    <div className="px-3 py-1.5 flex items-center gap-2 hover:bg-muted/40">
      <button
        type="button"
        onClick={() => onDuplicate('+X')}
        className="flex items-center gap-2 text-sm text-left flex-1 min-w-0 hover:text-foreground"
        title="Duplicate one bbox-width along +X (default)"
      >
        <CopyPlus className="h-4 w-4 text-muted-foreground" />
        <span>Duplicate</span>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground/70">⌘D</span>
      </button>
      <div className="flex items-center gap-0.5 shrink-0 border-l border-border/60 pl-2">
        <DirectionChip dir="+X" label="→" tooltip="Duplicate +X (east)" onClick={() => onDuplicate('+X')} />
        <DirectionChip dir="-X" label="←" tooltip="Duplicate −X (west)" onClick={() => onDuplicate('-X')} />
        <DirectionChip dir="+Y" label="↗" tooltip="Duplicate +Y (north)" onClick={() => onDuplicate('+Y')} />
        <DirectionChip dir="-Y" label="↙" tooltip="Duplicate −Y (south)" onClick={() => onDuplicate('-Y')} />
        <DirectionChip dir="+Z" label="↑" tooltip="Duplicate +Z (up)" onClick={() => onDuplicate('+Z')} />
        <DirectionChip dir="-Z" label="↓" tooltip="Duplicate −Z (down)" onClick={() => onDuplicate('-Z')} />
      </div>
    </div>
  );
}

function DirectionChip({
  dir,
  label,
  tooltip,
  onClick,
}: {
  dir: DuplicateDirection;
  label: string;
  tooltip: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      className="h-5 w-5 flex items-center justify-center rounded text-[11px] font-mono leading-none text-muted-foreground hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-foreground transition-colors"
      data-direction={dir}
    >
      {label}
    </button>
  );
}

function MenuItem({ icon: Icon, label, onClick, disabled, shortcut, tone = 'default' }: MenuItemProps) {
  const iconClass =
    tone === 'destructive'
      ? 'h-4 w-4 text-red-500 dark:text-red-400'
      : 'h-4 w-4 text-muted-foreground';
  const hoverClass =
    tone === 'destructive'
      ? 'hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-700 dark:hover:text-red-300'
      : 'hover:bg-muted';
  return (
    <button
      className={`w-full px-3 py-1.5 text-sm text-left flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${hoverClass}`}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className={iconClass} />
      <span className="flex-1 min-w-0">{label}</span>
      {shortcut && (
        <span className="text-[10px] font-mono text-muted-foreground/70 shrink-0">
          {shortcut}
        </span>
      )}
    </button>
  );
}
