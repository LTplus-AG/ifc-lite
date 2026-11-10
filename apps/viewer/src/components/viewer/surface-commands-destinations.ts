/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Parameterized destinations use the same labels and actions as their real controls (#8947). */
import { openErrorReportDestination } from '@/lib/error-reports/destination';
import { openModelPlan } from './model/open-model-plan';
import { openRetainedReport } from './retained-report-destination';
import { registerEnglish } from '@/i18n';
import { retainedGeometryEn } from '@/i18n/catalogues/retained-geometry.en';
import { Ruler, Scissors, Settings, Search, Crosshair } from 'lucide-react';
import { useViewerStore } from '@/store';
import { openSettings, SETTINGS_SECTIONS } from '@/lib/settings/open-settings';
import { openMeasurementDestination } from '@/lib/panels/measurement-destination';
import { MEASURE_MODE_LABELS } from './tools/measure-modes/readouts';
import { SECTION_ADD_ENTRIES } from './tools/SectionAddMenu';
import type { SurfaceCommandDefinition } from './surface-command-types';

registerEnglish(retainedGeometryEn);

const base = { surfaces: ['palette'], enabled: () => true } as const;
export const DESTINATION_SURFACE_COMMANDS = [
  ...SETTINGS_SECTIONS.map(section => ({
    ...base, id: `settings:${section}` as const, labelKey: `settings.sections.${section}` as const,
    keywords: `settings preferences ${section}`, keywordsKey: `commandPalette.paths.settings.${section}` as const,
    detailKey: `commandPalette.paths.settings.${section}` as const,
    category: 'Preferences', icon: Settings, run: () => openSettings(section),
  } satisfies SurfaceCommandDefinition)),
  ...MEASURE_MODE_LABELS.map(([mode, labelKey]) => ({
    ...base, id: `measure:${mode}` as const, labelKey,
    keywords: `measure measurement ${mode}`, keywordsKey: 'commandPalette.paths.measure' as const, detailKey: 'commandPalette.paths.measure' as const,
    category: 'Tools', icon: Ruler,
    run: () => {
      const s = useViewerStore.getState();
      s.setMeasureMode(mode);
      s.setActiveTool('measure');
      if (mode === 'point') openMeasurementDestination('point');
    },
  } satisfies SurfaceCommandDefinition)),
  ...(['list', 'point', 'quantities', 'centreline'] as const).map(tab => ({
    ...base, id: `measure-panel:${tab}` as const, labelKey: `measure.section.${tab}.title` as const,
    keywords: `measurements panel ${tab}`, keywordsKey: 'commandPalette.paths.measurePanel' as const, detailKey: 'commandPalette.paths.measurePanel' as const,
    category: 'Panels', icon: Ruler, run: () => openMeasurementDestination(tab),
  } satisfies SurfaceCommandDefinition)),
  ...SECTION_ADD_ENTRIES.map(({ kind, labelKey, titleKey }) => ({
    ...base, id: `section-add:${kind}` as const, labelKey,
    keywords: `section cut add ${kind}`, keywordsKey: 'commandPalette.paths.sectionAdd' as const, detailKey: titleKey,
    category: 'Tools', icon: Scissors,
    run: (context) => {
      if (!context.addSectionPlane) throw new Error('Section destination requires its mounted host');
      context.addSectionPlane(kind);
    },
  } satisfies SurfaceCommandDefinition)),
  ...(['filter', 'libraries'] as const).map(tab => ({
    ...base, id: `search:${tab}` as const,
    labelKey: tab === 'filter' ? 'searchModal.shell.filterTab' : 'searchModal.library.title',
    keywords: `search ${tab}`, keywordsKey: `commandPalette.paths.search.${tab}` as const, detailKey: `commandPalette.paths.search.${tab}` as const,
    category: 'Tools', icon: Search,
    run: () => {
      const s = useViewerStore.getState();
      s.setSearchModalTab(tab);
      s.setSearchModalOpen(true);
    },
  } satisfies SurfaceCommandDefinition)),
  {
    ...base, id: 'model:plan', labelKey: 'modelWorkspace.plan.show',
    keywords: 'model plan split layout 2d 3d', keywordsKey: 'commandPalette.paths.modelPlan',
    category: 'Tools', icon: Crosshair, run: () => { openModelPlan(); },
  },
  {
    ...base, id: 'panel:error-report', labelKey: 'commandPalette.errorReport.label',
    keywords: 'report error bug failed load report help improve resume recent report pending report',
    keywordsKey: 'commandPalette.errorReport.aliases', detailKey: 'commandPalette.paths.errorReport',
    category: 'Panels', icon: Search, run: () => openErrorReportDestination(),
  },
  {
    ...base, id: 'panel:retained-report', labelKey: 'retainedGeometry.chip.aria',
    keywords: 'retained geometry report refused missing products diagnostics', keywordsKey: 'commandPalette.paths.retainedReport',
    category: 'Panels', icon: Search, run: openRetainedReport,
  },
  {
    ...base, id: 'view:basepoints', labelKey: 'viewportLighting.overlays.basepointToggle.showAria',
    keywords: 'show model basepoints origin IFC 0 0 0', keywordsKey: 'commandPalette.paths.basepoints',
    category: 'View', icon: Crosshair,
    run: () => useViewerStore.getState().setShowModelBasepoints(true),
  },
] as const satisfies readonly SurfaceCommandDefinition[];
