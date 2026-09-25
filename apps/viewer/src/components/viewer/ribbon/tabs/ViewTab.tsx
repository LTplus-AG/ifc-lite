/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · View tab — camera presets and projection, world context
 * (Cesium / sun / SpaceMouse), and interface options.
 */

import { Orthographic, Viewpoint, SpaceMouse, Lighting, World, Move, FollowWork, ClassicBar, Settings } from '@/icons';
import { useViewerStore } from '@/store';
import { useEffectiveSkyEnabled } from '@/hooks/useEffectiveSkyEnabled';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { openSettings } from '@/lib/settings/open-settings';
import { useTranslation } from '@/i18n';
import { useCameraCommands } from '../../toolbar/CameraCommands';
import { useWorkspacePanelControls } from '../../toolbar/useWorkspacePanelControls';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
  RibbonSmallButton,
  RibbonSmallStack,
} from '../primitives';

export function ViewTab() {
  const { t } = useTranslation();
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
  const { activeWorkspacePanels, handleToggleBottomPanel } = useWorkspacePanelControls('ribbon');

  // Environment panel state (sky, lighting presets, sun-path study, #5506)
  const solarEnabled = useViewerStore((state) => state.solarEnabled);
  // Effective, not raw: the Cesium world context defaults this on (#4771).
  const envSkyEnabled = useEffectiveSkyEnabled();
  const envPreset = useViewerStore((state) => state.envPreset);

  // SpaceMouse connection state (3D mouse navigation, #1677); its settings
  // moved to Preferences → Navigation (#5509).
  const spaceMouseConnected = useViewerStore((state) => state.spaceMouseConnected);

  // Basket presentation state. The dock flag (`basketPresentationVisible`) is
  // still the source of truth for "active" — the `presentation` bottom panel
  // reuses it (#5508) — but opening/closing routes through the bottom-panel
  // table (`handleToggleBottomPanel`) rather than the raw toggle, so it stays
  // mutually exclusive with Script/Schedule/Lists/etc. instead of stacking a
  // second bottom panel open underneath.
  const pinboardEntities = useViewerStore((state) => state.pinboardEntities);
  const basketViewCount = useViewerStore((state) => state.basketViews.length);
  const hasModels = useViewerStore((state) => state.models.size > 0 || (state.geometryResult?.meshes.length ?? 0) > 0);

  return (
    <>
      <RibbonGroup label={t('ribbon.view.projectionGroup')}>
        <RibbonLargeButton
          icon={Orthographic}
          label={t('ribbon.view.orthographic')}
          tooltip={t('ribbon.view.orthographicTooltip')}
          active={projectionMode === 'orthographic'}
          onClick={() => toggleProjectionMode()}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.view.cameraGroup')}>
        {cameraCommands
          .filter((command) => command.group === 'camera')
          .map((command) => (
            <RibbonLargeButton
              key={command.id}
              icon={command.icon}
              label={t(command.labelKey)}
              tooltip={t(command.tooltipKey)}
              shortcut={command.shortcut}
              onClick={command.run}
            />
          ))}
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.view.viewGroup')}>
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
                  label={t(command.labelKey)}
                  shortcut={command.shortcut}
                  onClick={command.run}
                />
              ))}
          </RibbonSmallStack>
        ))}
        {/* Everything that isn't a camera command or an axis view — the 90°
            rotations today, and whatever the shared list grows next. */}
        {cameraCommands
          .filter((command) => command.group !== 'camera' && command.group !== 'preset')
          .map((command) => (
            <RibbonLargeButton
              key={command.id}
              icon={command.icon}
              label={t(command.labelKey)}
              tooltip={t(command.tooltipKey)}
              shortcut={command.shortcut}
              onClick={command.run}
            />
          ))}
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.view.contextGroup')}>
        {/* Cesium 3D World Context — the world-context affordance is one
            click away when a model has georeferencing. When active, the
            "Move georeference" sub-toggle appears beside it (its amber
            tint signals a modal pose whose exit affordance stays visible). */}
        {cesiumAvailable && (
          <RibbonLargeButton
            icon={World}
            label={t('ribbon.view.world')}
            tooltip={cesiumEnabled ? t('ribbon.view.worldHideTooltip') : t('ribbon.view.worldShowTooltip')}
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
          label={t('ribbon.view.lighting')}
          tooltip={t('ribbon.view.lightingTooltip')}
          active={activeWorkspacePanels.has('environment') || solarEnabled || envSkyEnabled || envPreset !== 'default'}
          activeClassName="bg-amber-500/20 text-foreground ring-1 ring-inset ring-amber-500/50"
          onClick={() => useViewerStore.getState().toggleWorkspacePanel('environment', 'ribbon')}
        />
        <RibbonSmallStack>
          {cesiumAvailable && cesiumEnabled && (
            <RibbonSmallButton
              icon={Move}
              label={t('ribbon.view.moveGeoref')}
              tooltip={cesiumPlacementEditMode ? t('ribbon.view.moveGeorefStopTooltip') : t('ribbon.view.moveGeorefStartTooltip')}
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
            label={t('ribbon.view.spaceMouse')}
            tooltip={t('ribbon.view.spaceMouseTooltip')}
            active={spaceMouseConnected}
            activeClassName="bg-primary/20 text-foreground ring-1 ring-inset ring-primary/50"
            onClick={() => openSettings('display')}
          />
        </RibbonSmallStack>
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.view.interfaceGroup')}>
        <RibbonLargeButton
          icon={Viewpoint}
          label={t('ribbon.view.present')}
          tooltip={t('ribbon.view.presentTooltip', { views: basketViewCount, entities: pinboardEntities.size })}
          active={activeWorkspacePanels.has('presentation')}
          disabled={!hasModels}
          onClick={() => handleToggleBottomPanel('presentation')}
          badge={(basketViewCount > 0 || pinboardEntities.size > 0) ? (
            <span className="absolute -top-0.5 right-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full border border-background bg-primary px-0.5 text-[9px] font-bold text-primary-foreground">
              {basketViewCount > 0 ? `${basketViewCount}/${pinboardEntities.size}` : pinboardEntities.size}
            </span>
          ) : undefined}
        />
        <RibbonSmallStack>
          <RibbonSmallButton
            icon={FollowWork}
            label={t('ribbon.view.followWork')}
            tooltip={t('ribbon.view.followWorkTooltip')}
            active={ribbonContextualTabs}
            onClick={() => setRibbonContextualTabs(!ribbonContextualTabs)}
            {...tourAnchor(TOUR_ANCHORS.ribbonFollowWork)}
          />
          <RibbonSmallButton
            icon={ClassicBar}
            label={t('ribbon.view.classicBar')}
            tooltip={t('ribbon.view.classicBarTooltip')}
            onClick={() => setToolbarStyle('classic')}
            {...tourAnchor(TOUR_ANCHORS.ribbonClassicSwitch)}
          />
          <RibbonSmallButton
            icon={Settings}
            label={t('ribbon.view.settings')}
            tooltip={t('ribbon.view.settingsTooltip')}
            onClick={() => openSettings()}
          />
        </RibbonSmallStack>
      </RibbonGroup>
    </>
  );
}
