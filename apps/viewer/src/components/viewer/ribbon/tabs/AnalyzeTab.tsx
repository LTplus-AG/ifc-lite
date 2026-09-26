/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · Analyze tab — the workspace panels: validation, comparison,
 * data tables, styling rules, and analysis extensions. Buttons latch to
 * mirror each panel's open state; the single-tenant dock rules live in
 * `useWorkspacePanelControls`, shared with the classic toolbar.
 */

import { Issue, List, Compare, Layer, Clash, Check, Script, Schedule, Coloring, Zones, LoadReport, Chart, Document, Cost, Flow, Drawing } from '@/icons';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
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
  const { t } = useTranslation();
  const {
    activeWorkspacePanels,
    handleToggleBottomPanel,
    handleToggleRightPanel,
    handleToggleAnalysisExtension,
    rightAnalysisExtensions,
    bottomAnalysisExtensions,
  } = useWorkspacePanelControls('ribbon');

  const analysisExtensions = [...rightAnalysisExtensions, ...bottomAnalysisExtensions];

  return (
    <>
      <RibbonGroup label={t('ribbon.analyze.validateGroup')}>
        <RibbonLargeButton
          icon={Issue}
          label={t('ribbon.analyze.bcfTopics')}
          active={activeWorkspacePanels.has('bcf')}
          onClick={() => handleToggleRightPanel('bcf')}
        />
        <RibbonLargeButton
          icon={Check}
          label={t('ribbon.analyze.ids')}
          tooltip={t('ribbon.analyze.idsTooltip')}
          active={activeWorkspacePanels.has('validation')}
          onClick={() => handleToggleRightPanel('validation')}
        />
        <RibbonLargeButton
          icon={Clash}
          label={t('ribbon.analyze.clash')}
          tooltip={t('ribbon.analyze.clashTooltip')}
          active={activeWorkspacePanels.has('clash')}
          onClick={() => handleToggleRightPanel('clash')}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.analyze.compareGroup')}>
        <RibbonLargeButton
          icon={Compare}
          label={t('ribbon.analyze.compare')}
          tooltip={t('ribbon.analyze.compareTooltip')}
          active={activeWorkspacePanels.has('compare')}
          onClick={() => handleToggleRightPanel('compare')}
        />
        <RibbonLargeButton
          icon={Layer}
          label={t('ribbon.analyze.layers')}
          tooltip={t('ribbon.analyze.layersTooltip')}
          active={activeWorkspacePanels.has('layers')}
          onClick={() => useViewerStore.getState().toggleWorkspacePanel('layers', 'ribbon')}
        />
        {/* Location zones (#1810), reachable from a toolbar for the first time
            (#2508): the ActivityBar rail was its only entry point. */}
        <RibbonLargeButton
          icon={Zones}
          label={t('ribbon.analyze.zones')}
          tooltip={t('ribbon.analyze.zonesTooltip')}
          active={activeWorkspacePanels.has('zones')}
          onClick={() => useViewerStore.getState().toggleWorkspacePanel('zones', 'ribbon')}
        />
        {/* Per-model load report (#3927): actionable geometry warnings. */}
        <RibbonLargeButton
          icon={LoadReport}
          label={t('ribbon.analyze.loadReport')}
          tooltip={t('ribbon.analyze.loadReportTooltip')}
          active={activeWorkspacePanels.has('loadReport')}
          onClick={() => useViewerStore.getState().toggleWorkspacePanel('loadReport', 'ribbon')}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.analyze.dataGroup')}>
        {/* IFC 5D cost inspector (#4858): reachable from a toolbar for the
            first time — the ActivityBar rail was its only entry point. */}
        <RibbonLargeButton
          icon={Cost}
          label={t('ribbon.analyze.cost')}
          tooltip={t('ribbon.analyze.costTooltip')}
          active={activeWorkspacePanels.has('cost')}
          onClick={() => useViewerStore.getState().toggleWorkspacePanel('cost', 'ribbon')}
        />
        <RibbonLargeButton
          icon={List}
          label={t('ribbon.analyze.lists')}
          tooltip={t('ribbon.analyze.listsTooltip')}
          active={activeWorkspacePanels.has('lists')}
          onClick={() => handleToggleBottomPanel('lists')}
        />
        <RibbonLargeButton
          icon={Schedule}
          label={t('ribbon.analyze.schedule')}
          tooltip={t('ribbon.analyze.scheduleTooltip')}
          active={activeWorkspacePanels.has('gantt')}
          onClick={() => handleToggleBottomPanel('gantt')}
        />
        <RibbonLargeButton
          icon={Chart}
          label={t('ribbon.analyze.charts')}
          tooltip={t('ribbon.analyze.chartsTooltip')}
          active={activeWorkspacePanels.has('charts')}
          onClick={() => handleToggleBottomPanel('charts')}
        />
        <RibbonLargeButton
          icon={Document}
          label={t('ribbon.analyze.document')}
          tooltip={t('ribbon.analyze.documentTooltip')}
          active={activeWorkspacePanels.has('document')}
          onClick={() => handleToggleBottomPanel('document')}
        />
        <RibbonLargeButton
          icon={Drawing}
          label={t('ribbon.analyze.drawing')}
          tooltip={t('ribbon.analyze.drawingTooltip')}
          active={activeWorkspacePanels.has('drawing')}
          onClick={() => handleToggleBottomPanel('drawing')}
        />
        <RibbonLargeButton
          icon={Script}
          label={t('ribbon.analyze.script')}
          tooltip={t('ribbon.analyze.scriptTooltip')}
          active={activeWorkspacePanels.has('script')}
          onClick={() => handleToggleBottomPanel('script')}
        />
        <RibbonLargeButton
          icon={Flow}
          label={t('ribbon.analyze.flow')}
          tooltip={t('ribbon.analyze.flowTooltip')}
          active={activeWorkspacePanels.has('flow')}
          onClick={() => handleToggleBottomPanel('flow')}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.analyze.styleGroup')}>
        <RibbonLargeButton
          icon={Coloring}
          label={t('ribbon.analyze.lens')}
          tooltip={t('ribbon.analyze.lensTooltip')}
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
          <RibbonGroup label={t('ribbon.analyze.appsGroup')}>
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
