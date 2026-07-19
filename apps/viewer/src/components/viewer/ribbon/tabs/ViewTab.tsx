/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · View tab — camera presets and projection, class visibility,
 * world context (Cesium / sun / SpaceMouse), and interface options.
 */

import { Globe2, Move, PanelTop, } from 'lucide-react';
import { TopView, BottomView, FrontView, BackView, LeftView, RightView, IsometricView, Orthographic, Viewpoint, SpaceMouse, Lighting, ElementTooltips, ClassVisibility } from '@/icons';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useViewerStore } from '@/store';
import { goHomeFromStore } from '@/store/homeView';
import { ClassVisibilityMenuContent, useVisibleClassCount } from '../../toolbar/ClassVisibilityMenu';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
  RibbonSmallButton,
  RibbonSmallStack,
} from '../primitives';

export function ViewTab() {
  const cameraCallbacks = useViewerStore((state) => state.cameraCallbacks);
  const projectionMode = useViewerStore((state) => state.projectionMode);
  const toggleProjectionMode = useViewerStore((state) => state.toggleProjectionMode);
  const hoverTooltipsEnabled = useViewerStore((state) => state.hoverTooltipsEnabled);
  const toggleHoverTooltips = useViewerStore((state) => state.toggleHoverTooltips);
  const mergeLayers = useViewerStore((state) => state.mergeLayers);
  const { visible: visibleClassCount } = useVisibleClassCount();
  const setToolbarStyle = useViewerStore((state) => state.setToolbarStyle);

  // Cesium 3D overlay state
  const cesiumAvailable = useViewerStore((state) => state.cesiumAvailable);
  const cesiumEnabled = useViewerStore((state) => state.cesiumEnabled);
  const toggleCesium = useViewerStore((state) => state.toggleCesium);
  const cesiumPlacementEditMode = useViewerStore((state) => state.cesiumPlacementEditMode);
  const setCesiumPlacementEditMode = useViewerStore((state) => state.setCesiumPlacementEditMode);
  const activeTool = useViewerStore((state) => state.activeTool);
  const setActiveTool = useViewerStore((state) => state.setActiveTool);

  // Sun & Sky panel state (sky, lighting presets, sun-path study)
  const solarEnabled = useViewerStore((state) => state.solarEnabled);
  const envPanelOpen = useViewerStore((state) => state.envPanelOpen);
  const toggleEnvPanel = useViewerStore((state) => state.toggleEnvPanel);
  const envSkyEnabled = useViewerStore((state) => state.envSkyEnabled);
  const envPreset = useViewerStore((state) => state.envPreset);

  // SpaceMouse panel state (3D mouse navigation, #1677)
  const spaceMousePanelOpen = useViewerStore((state) => state.spaceMousePanelOpen);
  const toggleSpaceMousePanel = useViewerStore((state) => state.toggleSpaceMousePanel);
  const spaceMouseConnected = useViewerStore((state) => state.spaceMouseConnected);

  // Basket presentation state
  const pinboardEntities = useViewerStore((state) => state.pinboardEntities);
  const basketViewCount = useViewerStore((state) => state.basketViews.length);
  const basketPresentationVisible = useViewerStore((state) => state.basketPresentationVisible);
  const toggleBasketPresentationVisible = useViewerStore((state) => state.toggleBasketPresentationVisible);
  const hasModels = useViewerStore((state) => state.models.size > 0 || (state.geometryResult?.meshes.length ?? 0) > 0);

  return (
    <>
      <RibbonGroup label="Camera">
        <RibbonLargeButton
          icon={IsometricView}
          label="Isometric"
          tooltip="Home (isometric + reset visibility)"
          shortcut="H"
          onClick={goHomeFromStore}
        />
        <RibbonSmallStack>
          <RibbonSmallButton icon={TopView} label="Top" shortcut="1" onClick={() => cameraCallbacks.setPresetView?.('top')} />
          <RibbonSmallButton icon={FrontView} label="Front" shortcut="3" onClick={() => cameraCallbacks.setPresetView?.('front')} />
          <RibbonSmallButton icon={LeftView} label="Left" shortcut="5" onClick={() => cameraCallbacks.setPresetView?.('left')} />
        </RibbonSmallStack>
        <RibbonSmallStack>
          <RibbonSmallButton icon={BottomView} label="Bottom" shortcut="2" onClick={() => cameraCallbacks.setPresetView?.('bottom')} />
          <RibbonSmallButton icon={BackView} label="Back" shortcut="4" onClick={() => cameraCallbacks.setPresetView?.('back')} />
          <RibbonSmallButton icon={RightView} label="Right" shortcut="6" onClick={() => cameraCallbacks.setPresetView?.('right')} />
        </RibbonSmallStack>
        <RibbonSmallStack>
          <RibbonSmallButton
            icon={Orthographic}
            label="Orthographic"
            tooltip="Toggle orthographic projection"
            active={projectionMode === 'orthographic'}
            onClick={() => toggleProjectionMode()}
          />
        </RibbonSmallStack>
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Visibility">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RibbonLargeButton
              icon={ClassVisibility}
              label="Classes"
              hasMenu
              tooltip={mergeLayers
                ? `Class visibility (${visibleClassCount} on) · Merge Multilayer Walls is on`
                : `Class visibility (${visibleClassCount} on)`}
              badge={mergeLayers ? (
                // Tiny accent dot announcing that a non-default load
                // setting is active. Decorative — semantics live on the
                // button's tooltip.
                <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary ring-1 ring-background" />
              ) : undefined}
            />
          </DropdownMenuTrigger>
          <ClassVisibilityMenuContent align="start" />
        </DropdownMenu>
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Context">
        {/* Cesium 3D World Context — the world-context affordance is one
            click away when a model has georeferencing. When active, the
            "Move georeference" sub-toggle appears beside it (its amber
            tint signals a modal pose whose exit affordance stays visible). */}
        {cesiumAvailable && (
          <RibbonLargeButton
            icon={Globe2}
            label="World"
            tooltip={cesiumEnabled ? 'Hide 3D world context (Cesium)' : 'Show 3D world context (Cesium)'}
            active={cesiumEnabled}
            activeClassName="bg-teal-600/20 text-foreground ring-1 ring-inset ring-teal-600/50"
            onClick={() => {
              toggleCesium();
              if (cesiumEnabled) {
                setCesiumPlacementEditMode(false);
                if (activeTool === 'cesium-placement') setActiveTool('select');
              }
            }}
          />
        )}
        <RibbonLargeButton
          icon={Lighting}
          label="Lighting"
          tooltip="Sun, sky and lighting presets"
          active={envPanelOpen || solarEnabled || envSkyEnabled || envPreset !== 'default'}
          activeClassName="bg-amber-500/20 text-foreground ring-1 ring-inset ring-amber-500/50"
          onClick={toggleEnvPanel}
        />
        <RibbonSmallStack>
          {cesiumAvailable && cesiumEnabled && (
            <RibbonSmallButton
              icon={Move}
              label="Move georef"
              tooltip={cesiumPlacementEditMode ? 'Stop moving georeference' : 'Move georeference in Cesium'}
              active={cesiumPlacementEditMode}
              activeClassName="bg-amber-500/20 text-foreground ring-1 ring-inset ring-amber-500/50"
              onClick={() => {
                const next = !cesiumPlacementEditMode;
                setCesiumPlacementEditMode(next);
                setActiveTool(next ? 'cesium-placement' : 'select');
              }}
            />
          )}
          <RibbonSmallButton
            icon={SpaceMouse}
            label="SpaceMouse"
            tooltip="Connect a 3Dconnexion SpaceMouse (WebHID)"
            active={spaceMousePanelOpen || spaceMouseConnected}
            activeClassName="bg-teal-600/20 text-foreground ring-1 ring-inset ring-teal-600/50"
            onClick={toggleSpaceMousePanel}
          />
        </RibbonSmallStack>
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Interface">
        <RibbonLargeButton
          icon={Viewpoint}
          label="Present"
          tooltip={`Basket presentation dock (views: ${basketViewCount}, entities: ${pinboardEntities.size})`}
          active={basketPresentationVisible}
          disabled={!hasModels}
          onClick={toggleBasketPresentationVisible}
          badge={(basketViewCount > 0 || pinboardEntities.size > 0) ? (
            <span className="absolute -top-0.5 right-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full border border-background bg-primary px-0.5 text-[9px] font-bold text-primary-foreground">
              {basketViewCount > 0 ? `${basketViewCount}/${pinboardEntities.size}` : pinboardEntities.size}
            </span>
          ) : undefined}
        />
        <RibbonSmallStack>
          <RibbonSmallButton
            icon={ElementTooltips}
            label="Hover tips"
            tooltip="Show entity tooltips on hover"
            active={hoverTooltipsEnabled}
            onClick={() => toggleHoverTooltips()}
          />
          <RibbonSmallButton
            icon={PanelTop}
            label="Classic bar"
            tooltip="Switch back to the classic single-strip toolbar"
            onClick={() => setToolbarStyle('classic')}
          />
        </RibbonSmallStack>
      </RibbonGroup>
    </>
  );
}
