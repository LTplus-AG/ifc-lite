/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · Home tab — the everyday loop: pick a tool, measure or cut,
 * and get the camera back home.
 */

import { openRepositionModels } from '@/lib/model-placement/commands';
import { Select, Walk, Annotate, Measure, Section, Home, Reposition } from '@/icons';
import { useViewerStore } from '@/store';
import { goHomeFromStore } from '@/store/homeView';
import { tourAnchor, toolAnchor } from '@/lib/tours/anchors';
import { useTranslation } from '@/i18n';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
} from '../primitives';

export function HomeTab() {
  const { t } = useTranslation();
  const activeTool = useViewerStore((state) => state.activeTool);
  const setActiveTool = useViewerStore((state) => state.setActiveTool);

  return (
    <>
      <RibbonGroup label={t('ribbon.home.toolsGroup')}>
        <RibbonLargeButton icon={Reposition} label={t('ribbon.home.reposition')} tooltip={t('ribbon.home.repositionTooltip')} onClick={() => openRepositionModels()} />
        <RibbonLargeButton
          icon={Select}
          label={t('ribbon.home.select')}
          shortcut="tool.select"
          active={activeTool === 'select'}
          onClick={() => setActiveTool('select')}
          {...tourAnchor(toolAnchor('select'))}
        />
        <RibbonLargeButton
          icon={Walk}
          label={t('ribbon.home.walk')}
          shortcut="tool.walk"
          active={activeTool === 'walk'}
          onClick={() => setActiveTool('walk')}
          {...tourAnchor(toolAnchor('walk'))}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.home.measureGroup')}>
        <RibbonLargeButton
          icon={Measure}
          label={t('ribbon.home.measure')}
          shortcut="tool.measure"
          active={activeTool === 'measure'}
          onClick={() => setActiveTool('measure')}
          {...tourAnchor(toolAnchor('measure'))}
        />
        <RibbonLargeButton
          icon={Section}
          label={t('ribbon.home.section')}
          shortcut="tool.section"
          active={activeTool === 'section'}
          onClick={() => setActiveTool('section')}
          {...tourAnchor(toolAnchor('section'))}
        />
        <RibbonLargeButton
          icon={Annotate}
          label={t('ribbon.home.annotate')}
          shortcut="tool.annotate"
          active={activeTool === 'annotate'}
          activeClassName="bg-amber-500/20 text-foreground ring-1 ring-inset ring-amber-500/50"
          onClick={() => setActiveTool('annotate')}
          {...tourAnchor(toolAnchor('annotate'))}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.home.sceneGroup')}>
        <RibbonLargeButton
          icon={Home}
          label={t('ribbon.home.home')}
          tooltip={t('ribbon.home.homeTooltip')}
          shortcut="camera.home"
          onClick={goHomeFromStore}
        />
      </RibbonGroup>
    </>
  );
}
