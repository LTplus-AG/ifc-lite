/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · Analyze tab — the workspace panels: validation, comparison,
 * data tables, styling rules, and analysis extensions. Buttons latch to
 * mirror each panel's open state; the single-tenant dock rules live in
 * `useWorkspacePanelControls`, shared with the classic toolbar.
 */

import {
  CalendarClock,
  ClipboardCheck,
  Crosshair,
  FileCode2,
  FileSpreadsheet,
  GitCompareArrows,
  Layers,
  MessageSquare,
  Palette,
} from 'lucide-react';
import { useViewerStore } from '@/store';
import { useWorkspacePanelControls } from '../../toolbar/useWorkspacePanelControls';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
  RibbonSmallButton,
  RibbonSmallStack,
} from '../primitives';

/** Chunk dynamic extension entries into ribbon-height stacks of three. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function AnalyzeTab() {
  const {
    activeWorkspacePanels,
    handleToggleBottomPanel,
    handleToggleRightPanel,
    handleToggleAnalysisExtension,
    rightAnalysisExtensions,
    bottomAnalysisExtensions,
  } = useWorkspacePanelControls();

  const analysisExtensions = [...rightAnalysisExtensions, ...bottomAnalysisExtensions];

  return (
    <>
      <RibbonGroup label="Validate">
        <RibbonLargeButton
          icon={MessageSquare}
          label="BCF Issues"
          active={activeWorkspacePanels.has('bcf')}
          onClick={() => handleToggleRightPanel('bcf')}
        />
        <RibbonLargeButton
          icon={ClipboardCheck}
          label="IDS Check"
          tooltip="IDS validation"
          active={activeWorkspacePanels.has('ids')}
          onClick={() => handleToggleRightPanel('ids')}
        />
        <RibbonLargeButton
          icon={Crosshair}
          label="Clash"
          tooltip="Clash detection"
          active={activeWorkspacePanels.has('clash')}
          onClick={() => handleToggleRightPanel('clash')}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Compare">
        <RibbonLargeButton
          icon={GitCompareArrows}
          label="Compare"
          tooltip="Compare models"
          active={activeWorkspacePanels.has('compare')}
          onClick={() => handleToggleRightPanel('compare')}
        />
        <RibbonLargeButton
          icon={Layers}
          label="Layers"
          tooltip="Layer stack"
          active={activeWorkspacePanels.has('layers')}
          onClick={() => useViewerStore.getState().toggleWorkspacePanel('layers')}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Data">
        <RibbonLargeButton
          icon={FileSpreadsheet}
          label="Lists"
          tooltip="Lists & schedules"
          active={activeWorkspacePanels.has('list')}
          onClick={() => handleToggleBottomPanel('list')}
        />
        <RibbonLargeButton
          icon={CalendarClock}
          label="Schedule"
          tooltip="Schedule (Gantt)"
          active={activeWorkspacePanels.has('gantt')}
          onClick={() => handleToggleBottomPanel('gantt')}
        />
        <RibbonLargeButton
          icon={FileCode2}
          label="Script"
          tooltip="Script editor"
          active={activeWorkspacePanels.has('script')}
          onClick={() => handleToggleBottomPanel('script')}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Style">
        <RibbonLargeButton
          icon={Palette}
          label="Lens"
          tooltip="Lens rules"
          active={activeWorkspacePanels.has('lens')}
          onClick={() => handleToggleRightPanel('lens')}
        />
      </RibbonGroup>

      {/* Analysis panels contributed by installed extensions. Only the
          contributed ANALYSIS panels live here — managing extensions and
          flavors themselves is workspace customization (Author tab). */}
      {analysisExtensions.length > 0 && (
        <>
          <RibbonGroupDivider />
          <RibbonGroup label="Apps">
            {chunk(analysisExtensions, 3).map((column, i) => (
              <RibbonSmallStack key={i}>
                {column.map((extension) => (
                  <RibbonSmallButton
                    key={extension.id}
                    icon={extension.icon}
                    label={extension.label}
                    active={activeWorkspacePanels.has(extension.id)}
                    onClick={() => handleToggleAnalysisExtension(extension.id)}
                  />
                ))}
              </RibbonSmallStack>
            ))}
          </RibbonGroup>
        </>
      )}
    </>
  );
}
