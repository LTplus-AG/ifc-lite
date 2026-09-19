/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CapabilityRisk } from '@ifc-lite/extensions';
import type { TranslationKey, UseTranslationResult } from '@/i18n';

const DESCRIPTION_KEY_BY_CAPABILITY_ID: Readonly<Record<string, TranslationKey>> = {
  'model.read': 'extensionsPanels.capabilityReview.capability.modelRead',
  'model.mutate': 'extensionsPanels.capabilityReview.capability.modelMutate',
  'model.create': 'extensionsPanels.capabilityReview.capability.modelCreate',
  'model.delete': 'extensionsPanels.capabilityReview.capability.modelDelete',
  'viewer.read': 'extensionsPanels.capabilityReview.capability.viewerRead',
  'viewer.colorize': 'extensionsPanels.capabilityReview.capability.viewerColorize',
  'viewer.isolate': 'extensionsPanels.capabilityReview.capability.viewerIsolate',
  'viewer.fly': 'extensionsPanels.capabilityReview.capability.viewerFly',
  'viewer.section': 'extensionsPanels.capabilityReview.capability.viewerSection',
  'export.create': 'extensionsPanels.capabilityReview.capability.exportCreate',
  'storage.local': 'extensionsPanels.capabilityReview.capability.storageLocal',
  'network.fetch': 'extensionsPanels.capabilityReview.capability.networkFetch',
  'command.invoke': 'extensionsPanels.capabilityReview.capability.commandInvoke',
  'ui.dock': 'extensionsPanels.capabilityReview.capability.uiDock',
  'ui.toolbar': 'extensionsPanels.capabilityReview.capability.uiToolbar',
  'ui.contextMenu': 'extensionsPanels.capabilityReview.capability.uiContextMenu',
  'ui.statusBar': 'extensionsPanels.capabilityReview.capability.uiStatusBar',
};

type Translate = UseTranslationResult['t'];

/** Resolve package diagnostics through the active viewer locale. */
export function localizeCapabilityRisk(risk: CapabilityRisk, t: Translate): string {
  if (risk.reasonCode === 'unknown-capability') {
    return t('extensionsPanels.capabilityReview.risk.unknownCapability', {
      raw: risk.capability.raw,
    });
  }

  const descriptionKey = DESCRIPTION_KEY_BY_CAPABILITY_ID[risk.capabilityId];
  if (!descriptionKey) {
    return t('extensionsPanels.capabilityReview.unknownCapabilityDescription');
  }
  const description = t(descriptionKey);

  switch (risk.reasonCode) {
    case 'catalogue':
      return risk.capability.target
        ? t('extensionsPanels.capabilityReview.risk.target', {
            description,
            target: risk.capability.target.raw,
          })
        : description;
    case 'missing-required-target':
      return t('extensionsPanels.capabilityReview.risk.missingRequiredTarget', { description });
    case 'universal-wildcard-target':
      return t('extensionsPanels.capabilityReview.risk.universalWildcardTarget', {
        description,
        target: risk.capability.target?.raw ?? '*',
      });
    case 'host-pattern-wildcard':
      return t('extensionsPanels.capabilityReview.risk.hostPatternWildcard', {
        description,
        target: risk.capability.target?.raw ?? '',
      });
    default: {
      const exhaustive: never = risk.reasonCode;
      return exhaustive;
    }
  }
}
