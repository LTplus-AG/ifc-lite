/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appearanceAssignmentListEn } from './catalogues/appearance-assignment-list.en';
import { appearanceAssignmentMembersEn } from './catalogues/appearance-assignment-members.en';
import { chartsEn } from './catalogues/charts.en';
import { commandPaletteEn } from './catalogues/command-palette.en';
import { compareKeyPropertyEn } from './catalogues/compare-key-property.en';
import { costPanelEn } from './catalogues/cost-panel.en';
import { ganttWorkCalendarEn } from './catalogues/gantt-work-calendar.en';
import { filterGroupsEn } from './catalogues/filter-groups.en';
import { documentEn } from './catalogues/document.en';
import { documentMenuEn } from './catalogues/document-menu.en';
import { mainToolbarEn } from './catalogues/main-toolbar.en';
import { measureEn } from './catalogues/measure.en';
import { mergeLayersBannerEn } from './catalogues/merge-layers-banner.en';
import { ribbonToolbarEn } from './catalogues/ribbon-toolbar.en';
import { sectionToolEn } from './catalogues/section-tool.en';
import { sharedCommandsEn } from './catalogues/shared-commands.en';
import { spaceSketchEn } from './catalogues/space-sketch.en';
import { splitToolEn } from './catalogues/split-tool.en';

/** English is assembled from feature catalogues so no locale becomes a monolith. */
export const en = {
  ...mergeLayersBannerEn,
  ...appearanceAssignmentListEn,
  ...appearanceAssignmentMembersEn,
  ...sectionToolEn,
  ...costPanelEn,
  ...ribbonToolbarEn,
  ...mainToolbarEn,
  ...sharedCommandsEn,
  ...commandPaletteEn,
  ...ganttWorkCalendarEn,
  ...filterGroupsEn,
  ...chartsEn,
  ...measureEn,
  ...spaceSketchEn,
  ...splitToolEn,
  ...documentEn,
  ...documentMenuEn,
  ...compareKeyPropertyEn,
} as const;

export type TranslationKey = keyof typeof en;
