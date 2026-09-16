/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appearanceAssignmentListEn } from './catalogues/appearance-assignment-list.en';
import { appearanceAssignmentMembersEn } from './catalogues/appearance-assignment-members.en';
import { costPanelEn } from './catalogues/cost-panel.en';
import { mergeLayersBannerEn } from './catalogues/merge-layers-banner.en';
import { sectionToolEn } from './catalogues/section-tool.en';

/** English is assembled from feature catalogues so no locale becomes a monolith. */
export const en = {
  ...mergeLayersBannerEn,
  ...appearanceAssignmentListEn,
  ...appearanceAssignmentMembersEn,
  ...sectionToolEn,
  ...costPanelEn,
} as const;

export type TranslationKey = keyof typeof en;
