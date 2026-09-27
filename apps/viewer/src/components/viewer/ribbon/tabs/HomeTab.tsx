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
} from '../primitives';
import { RibbonCommandLargeButton } from '../command-button';

export function HomeTab() {
  const { t } = useTranslation();
  const activeTool = useViewerStore((state) => state.activeTool);
  const setActiveTool = useViewerStore((state) => state.setActiveTool);

  return (
    <>
      <RibbonGroup label={t('ribbon.home.toolsGroup')}>
        <RibbonCommandLargeButton commandId="model:reposition" icon={Reposition} onClick={() => openRepositionModels()} />
        <RibbonCommandLargeButton
          commandId="tool:select"
          icon={Select}
          active={activeTool === 'select'}
          onClick={() => setActiveTool('select')}
          {...tourAnchor(toolAnchor('select'))}
        />
        <RibbonCommandLargeButton
          commandId="tool:walk"
          icon={Walk}
          active={activeTool === 'walk'}
          onClick={() => setActiveTool('walk')}
          {...tourAnchor(toolAnchor('walk'))}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.home.measureGroup')}>
        <RibbonCommandLargeButton
          commandId="tool:measure"
          icon={Measure}
          active={activeTool === 'measure'}
          onClick={() => setActiveTool('measure')}
          {...tourAnchor(toolAnchor('measure'))}
        />
        <RibbonCommandLargeButton
          commandId="tool:section"
          icon={Section}
          active={activeTool === 'section'}
          onClick={() => setActiveTool('section')}
          {...tourAnchor(toolAnchor('section'))}
        />
        <RibbonCommandLargeButton
          commandId="tool:annotate"
          icon={Annotate}
          active={activeTool === 'annotate'}
          activeClassName="bg-amber-500/20 text-foreground ring-1 ring-inset ring-amber-500/50"
          onClick={() => setActiveTool('annotate')}
          {...tourAnchor(toolAnchor('annotate'))}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.home.sceneGroup')}>
        <RibbonCommandLargeButton
          commandId="view:home"
          icon={Home}
          onClick={goHomeFromStore}
        />
      </RibbonGroup>
    </>
  );
}
