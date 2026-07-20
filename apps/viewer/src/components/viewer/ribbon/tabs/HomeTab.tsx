/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · Home tab — the everyday loop: pick a tool, measure or cut,
 * and get the camera back home.
 */

import { Select, Walk, Annotate, Measure, Section, Home } from '@/icons';
import { useViewerStore } from '@/store';
import { goHomeFromStore } from '@/store/homeView';
import { tourAnchor, toolAnchor } from '@/lib/tours/anchors';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
} from '../primitives';

export function HomeTab() {
  const activeTool = useViewerStore((state) => state.activeTool);
  const setActiveTool = useViewerStore((state) => state.setActiveTool);

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

      <RibbonGroup label="Scene">
        <RibbonLargeButton
          icon={Home}
          label="Home"
          tooltip="Home (isometric + reset visibility)"
          shortcut="H"
          onClick={goHomeFromStore}
        />
      </RibbonGroup>
    </>
  );
}
