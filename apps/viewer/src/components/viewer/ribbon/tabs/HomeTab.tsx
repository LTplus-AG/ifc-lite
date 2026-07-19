/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · Home tab — the everyday loop: pick a tool, measure or cut,
 * act on the selection, and get the camera back home.
 */

import { useCallback } from 'react';
import { Select, Walk, Annotate, Measure, Section, ShowAll, FitAll, Home, IsolateSelected, HideSelected, FocusSelected } from '@/icons';
import { useViewerStore } from '@/store';
import { goHomeFromStore, resetVisibilityForHomeFromStore } from '@/store/homeView';
import { executeBasketIsolate } from '@/store/basket/basketCommands';
import { tourAnchor, toolAnchor } from '@/lib/tours/anchors';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
  RibbonSmallButton,
  RibbonSmallStack,
} from '../primitives';

export function HomeTab() {
  const activeTool = useViewerStore((state) => state.activeTool);
  const setActiveTool = useViewerStore((state) => state.setActiveTool);
  const selectedEntityId = useViewerStore((state) => state.selectedEntityId);
  const selectedEntityIds = useViewerStore((state) => state.selectedEntityIds);
  const hideEntities = useViewerStore((state) => state.hideEntities);
  const clearSelection = useViewerStore((state) => state.clearSelection);
  const cameraCallbacks = useViewerStore((state) => state.cameraCallbacks);

  // Selection size uses the multi-select set when present; falls back to
  // the single legacy `selectedEntityId` so the count still reads "1"
  // for the click-to-pick flow that hasn't migrated.
  const selectionCount = selectedEntityIds.size > 0
    ? selectedEntityIds.size
    : (selectedEntityId !== null ? 1 : 0);
  const hasSelection = selectionCount > 0;

  const handleHide = useCallback(() => {
    // Hide ALL selected entities (multi-select or single)
    const state = useViewerStore.getState();
    const ids: number[] = state.selectedEntityIds.size > 0
      ? Array.from(state.selectedEntityIds)
      : selectedEntityId !== null ? [selectedEntityId] : [];
    if (ids.length > 0) {
      hideEntities(ids);
      clearSelection();
    }
  }, [selectedEntityId, hideEntities, clearSelection]);

  return (
    <>
      <RibbonGroup label="Tools">
        <RibbonLargeButton
          icon={Select}
          label="Select"
          shortcut="V"
          active={activeTool === 'select'}
          onClick={() => setActiveTool('select')}
          {...tourAnchor(toolAnchor('select'))}
        />
        <RibbonLargeButton
          icon={Walk}
          label="Walk"
          shortcut="C"
          active={activeTool === 'walk'}
          onClick={() => setActiveTool('walk')}
          {...tourAnchor(toolAnchor('walk'))}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Measure & Mark">
        <RibbonLargeButton
          icon={Measure}
          label="Measure"
          shortcut="M"
          active={activeTool === 'measure'}
          onClick={() => setActiveTool('measure')}
          {...tourAnchor(toolAnchor('measure'))}
        />
        <RibbonLargeButton
          icon={Section}
          label="Section"
          shortcut="X"
          active={activeTool === 'section'}
          onClick={() => setActiveTool('section')}
          {...tourAnchor(toolAnchor('section'))}
        />
        <RibbonLargeButton
          icon={Annotate}
          label="Annotate"
          shortcut="P"
          active={activeTool === 'annotate'}
          activeClassName="bg-amber-500/20 text-foreground ring-1 ring-inset ring-amber-500/50"
          onClick={() => setActiveTool('annotate')}
          {...tourAnchor(toolAnchor('annotate'))}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      {/* Selection actions stay put (no appearing/disappearing chrome —
          the ribbon's fixed geography is the point) and read their
          availability from the disabled state. The group label carries
          the live count so scene state is visible at a glance. */}
      <RibbonGroup label={hasSelection ? `Selection · ${selectionCount}` : 'Selection'}>
        <RibbonSmallStack>
          <RibbonSmallButton
            icon={IsolateSelected}
            label="Isolate"
            tooltip="Isolate selection (set basket)"
            shortcut="I / ="
            disabled={!hasSelection}
            onClick={() => executeBasketIsolate()}
          />
          <RibbonSmallButton
            icon={HideSelected}
            label="Hide"
            tooltip="Hide selection"
            shortcut="Del / Space"
            disabled={!hasSelection}
            onClick={handleHide}
          />
          <RibbonSmallButton
            icon={FocusSelected}
            label="Frame"
            tooltip="Frame selection"
            shortcut="F"
            disabled={!hasSelection}
            onClick={() => cameraCallbacks.frameSelection?.()}
          />
        </RibbonSmallStack>
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Scene">
        <RibbonLargeButton
          icon={Home}
          label="Home"
          tooltip="Home (isometric + reset visibility)"
          shortcut="H"
          onClick={goHomeFromStore}
        />
        <RibbonSmallStack>
          <RibbonSmallButton
            icon={ShowAll}
            label="Show all"
            tooltip="Show all (reset filters)"
            shortcut="A"
            onClick={resetVisibilityForHomeFromStore}
          />
          <RibbonSmallButton
            icon={FitAll}
            label="Fit all"
            tooltip="Fit all in view"
            shortcut="Z"
            onClick={() => cameraCallbacks.fitAll?.()}
          />
        </RibbonSmallStack>
      </RibbonGroup>
    </>
  );
}
