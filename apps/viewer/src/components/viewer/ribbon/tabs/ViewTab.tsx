/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · View tab — camera presets and projection, world context
 * (Cesium / sun / SpaceMouse), and interface options.
 */

import { Globe2, MousePointerClick, Move, PanelTop, } from 'lucide-react';
import { Orthographic, Viewpoint, SpaceMouse, Lighting } from '@/icons';
import { useViewerStore } from '@/store';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { useCameraCommands } from '../../toolbar/CameraCommands';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
  RibbonSmallButton,
  RibbonSmallStack,
} from '../primitives';

export function ViewTab() {
  // Camera, preset views and the 90° rotations come from the shared
  // command list the classic toolbar also renders, so the two styles
  // cannot host different camera commands (see toolbar/CameraCommands).
  const cameraCommands = useCameraCommands();
  const projectionMode = useViewerStore((state) => state.projectionMode);
  const toggleProjectionMode = useViewerStore((state) => state.toggleProjectionMode);
  const setToolbarStyle = useViewerStore((state) => state.setToolbarStyle);
  const ribbonContextualTabs = useViewerStore((state) => state.ribbonContextualTabs);
  const setRibbonContextualTabs = useViewerStore((state) => state.setRibbonContextualTabs);

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
      <RibbonGroup label="Projection">
        <RibbonLargeButton
          icon={Orthographic}
          label="Orthographic"
          tooltip="Toggle orthographic projection"
          active={projectionMode === 'orthographic'}
          onClick={() => toggleProjectionMode()}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Camera">
        {cameraCommands
          .filter((command) => command.group === 'camera')
          .map((command) => (
            <RibbonLargeButton
              key={command.id}
              icon={command.icon}
              label={command.label}
              tooltip={command.tooltip}
              shortcut={command.shortcut}
              onClick={command.run}
            />
          ))}
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="View">
        {/* The six axis views split across two small stacks in registry
            order (top/front/left over bottom/back/right). */}
        {[0, 1].map((column) => (
          <RibbonSmallStack key={column}>
            {cameraCommands
              .filter((command) => command.group === 'preset')
              .filter((_, index) => index % 2 === column)
              .map((command) => (
                <RibbonSmallButton
                  key={command.id}
                  icon={command.icon}
                  label={command.label}
                  shortcut={command.shortcut}
                  onClick={command.run}
                />
              ))}
          </RibbonSmallStack>
        ))}
        {cameraCommands
          .filter((command) => command.group === 'rotate')
          .map((command) => (
            <RibbonLargeButton
              key={command.id}
              icon={command.icon}
              label={command.label}
              tooltip={command.tooltip}
              onClick={command.run}
            />
          ))}
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
            icon={MousePointerClick}
            label="Follow work"
            tooltip="Open the Elements tab on selection and Author in edit mode, then hand the tab back"
            active={ribbonContextualTabs}
            onClick={() => setRibbonContextualTabs(!ribbonContextualTabs)}
            {...tourAnchor(TOUR_ANCHORS.ribbonFollowWork)}
          />
          <RibbonSmallButton
            icon={PanelTop}
            label="Classic bar"
            tooltip="Switch back to the classic single-strip toolbar (remembered on this browser)"
            onClick={() => setToolbarStyle('classic')}
            {...tourAnchor(TOUR_ANCHORS.ribbonClassicSwitch)}
          />
        </RibbonSmallStack>
      </RibbonGroup>
    </>
  );
}
