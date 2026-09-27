/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Ribbon Analyze tab. Panel shortcuts and the browser share registry groups (#5873). */
import type { ElementType } from 'react';
import { Issue, List, Compare, Layer, Clash, Check, Script, Schedule, Coloring, Zones, LoadReport, Chart, Document, Cost, Flow, Drawing } from '@/icons';
import { useViewerStore } from '@/store';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useWorkspacePanelControls } from '../../toolbar/useWorkspacePanelControls';
import { PANEL_GROUPS, panelGroupFor, panelTitleKey, type WorkspacePanelId } from '@/lib/panels/registry';
import { PanelGroupBrowser } from '../PanelGroupBrowser';
import { RibbonGroup, RibbonGroupDivider, RibbonLargeButton, RibbonSmallButton, RibbonSmallStack } from '../primitives';

interface FeaturedPanel {
  id: WorkspacePanelId;
  icon: ElementType;
  tooltipKey?: TranslationKey;
  onClick: () => void;
}

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

  // Existing quick actions keep their behavior and icons. Their visible
  // sections come from the registry, so they cannot introduce another panel
  // taxonomy beside the rail and Browse menu.
  const featuredPanels: FeaturedPanel[] = [
    { id: 'bcf', icon: Issue, onClick: () => handleToggleRightPanel('bcf') },
    { id: 'validation', icon: Check, tooltipKey: 'ribbon.analyze.idsTooltip', onClick: () => handleToggleRightPanel('validation') },
    { id: 'clash', icon: Clash, tooltipKey: 'ribbon.analyze.clashTooltip', onClick: () => handleToggleRightPanel('clash') },
    { id: 'compare', icon: Compare, tooltipKey: 'ribbon.analyze.compareTooltip', onClick: () => handleToggleRightPanel('compare') },
    { id: 'layers', icon: Layer, tooltipKey: 'ribbon.analyze.layersTooltip', onClick: () => useViewerStore.getState().toggleWorkspacePanel('layers', 'ribbon') },
    { id: 'zones', icon: Zones, tooltipKey: 'ribbon.analyze.zonesTooltip', onClick: () => useViewerStore.getState().toggleWorkspacePanel('zones', 'ribbon') },
    { id: 'loadReport', icon: LoadReport, tooltipKey: 'ribbon.analyze.loadReportTooltip', onClick: () => useViewerStore.getState().toggleWorkspacePanel('loadReport', 'ribbon') },
    { id: 'cost', icon: Cost, tooltipKey: 'ribbon.analyze.costTooltip', onClick: () => useViewerStore.getState().toggleWorkspacePanel('cost', 'ribbon') },
    { id: 'lists', icon: List, onClick: () => handleToggleBottomPanel('lists') },
    { id: 'gantt', icon: Schedule, tooltipKey: 'ribbon.analyze.scheduleTooltip', onClick: () => handleToggleBottomPanel('gantt') },
    { id: 'charts', icon: Chart, tooltipKey: 'ribbon.analyze.chartsTooltip', onClick: () => handleToggleBottomPanel('charts') },
    { id: 'document', icon: Document, tooltipKey: 'ribbon.analyze.documentTooltip', onClick: () => handleToggleBottomPanel('document') },
    { id: 'drawing', icon: Drawing, tooltipKey: 'ribbon.analyze.drawingTooltip', onClick: () => handleToggleBottomPanel('drawing') },
    { id: 'script', icon: Script, tooltipKey: 'ribbon.analyze.scriptTooltip', onClick: () => handleToggleBottomPanel('script') },
    { id: 'flow', icon: Flow, tooltipKey: 'ribbon.analyze.flowTooltip', onClick: () => handleToggleBottomPanel('flow') },
    { id: 'lens', icon: Coloring, tooltipKey: 'ribbon.analyze.lensTooltip', onClick: () => handleToggleRightPanel('lens') },
  ];
  const analysisExtensions = [...rightAnalysisExtensions, ...bottomAnalysisExtensions];

  return (
    <>
      <PanelGroupBrowser />
      {PANEL_GROUPS.map((group) => {
        const panels = featuredPanels.filter((panel) => panelGroupFor(panel.id) === group.id);
        if (panels.length === 0) return null;
        return (
          <div key={group.id} className="contents">
            <RibbonGroupDivider />
            <RibbonGroup label={t(group.labelKey)}>
              {panels.map((panel) => (
                <RibbonLargeButton
                  key={panel.id}
                  icon={panel.icon}
                  label={t(panelTitleKey(panel.id))}
                  aria-label={t(panelTitleKey(panel.id))}
                  tooltip={panel.tooltipKey ? t(panel.tooltipKey) : undefined}
                  active={activeWorkspacePanels.has(panel.id)}
                  onClick={panel.onClick}
                />
              ))}
            </RibbonGroup>
          </div>
        );
      })}

      {/* Installed analysis extensions have no workspace-panel registry id. */}
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
