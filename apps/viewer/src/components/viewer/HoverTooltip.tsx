/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hover tooltip showing entity info on mouseover
 */

import { useMemo } from 'react';
import { useViewerStore, resolveEntityRef } from '@/store';
import { useIfc } from '@/hooks/useIfc';

// Type icons mapping
const TYPE_ICONS: Record<string, string> = {
  IfcWall: '🧱',
  IfcWallStandardCase: '🧱',
  IfcDoor: '🚪',
  IfcWindow: '🪟',
  IfcSlab: '⬜',
  IfcColumn: '🏛️',
  IfcBeam: '➖',
  IfcStair: '🪜',
  IfcRailing: '🚧',
  IfcRoof: '🏠',
  IfcSpace: '📦',
  IfcBuildingStorey: '🏢',
  IfcBuilding: '🏗️',
  IfcSite: '📍',
  IfcProject: '📁',
  IfcFurnishingElement: '🪑',
  IfcFlowSegment: '〰️',
  IfcFlowTerminal: '⚡',
  IfcCurtainWall: '🔲',
};

export function HoverTooltip() {
  const hoverState = useViewerStore((s) => s.hoverState);
  const hoverTooltipsEnabled = useViewerStore((s) => s.hoverTooltipsEnabled);
  const { ifcDataStore, models } = useIfc();

  // `hoverState.entityId` is renderer-space (global, offset-per-model — set
  // from `pickResult.expressId` in `useMouseControls.ts`). It must be
  // resolved through `resolveEntityRef` to the entity's OWN model before
  // looking it up — the legacy `ifcDataStore` only tracks the ACTIVE model
  // (`modelSlice.ts`), which is the wrong store once a second, non-zero-
  // offset model is federated in.
  const entityInfo = useMemo(() => {
    if (!hoverState.entityId) {
      return null;
    }

    const ref = resolveEntityRef(hoverState.entityId);
    const dataStore = models.get(ref.modelId)?.ifcDataStore ?? ifcDataStore;
    if (!dataStore) {
      return null;
    }

    const name = dataStore.entities.getName(ref.expressId);
    const type = dataStore.entities.getTypeName(ref.expressId);

    return { name, type };
  }, [hoverState.entityId, ifcDataStore, models]);

  if (!hoverTooltipsEnabled || !hoverState.entityId || !entityInfo) {
    return null;
  }

  const icon = TYPE_ICONS[entityInfo.type] || '📄';

  return (
    <div
      className="fixed z-40 px-3 py-2 bg-popover text-popover-foreground rounded-md shadow-lg border pointer-events-none"
      style={{
        left: hoverState.screenX + 16,
        top: hoverState.screenY + 16,
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-base">{icon}</span>
        <span className="font-medium text-sm">
          {entityInfo.name || entityInfo.type}
        </span>
      </div>
      {entityInfo.name && (
        <div className="text-xs text-muted-foreground mt-0.5">
          {entityInfo.type}
        </div>
      )}
      <div className="text-xs text-muted-foreground">
        #{hoverState.entityId}
      </div>
      {hoverState.worldXYZ && (
        <div className="text-[10px] font-mono text-muted-foreground/80 mt-0.5">
          {hoverState.worldXYZ.x.toFixed(2)}, {hoverState.worldXYZ.y.toFixed(2)}, {hoverState.worldXYZ.z.toFixed(2)}
        </div>
      )}
    </div>
  );
}
