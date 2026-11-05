/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const ifcFederationAssumptionsDe = {
  'settings.ifcFederation.title': 'IFC-Föderation',
  'settings.ifcFederation.sharedVertical': 'Annehmen, dass IFC-Modelle ein gemeinsames Höhensystem verwenden',
  'settings.ifcFederation.hint': 'Standardmäßig aus. Aktivieren Sie dies nur, wenn Sie wissen, dass die IFC-Modelle und das Ankermodell dasselbe Höhensystem verwenden. Wenn ein Höhenbezug fehlt oder nicht aufgelöst werden kann, werden Höhen wie erfasst platziert. Eine falsche Annahme platziert Modelle zu hoch oder zu tief. Unterschiedliche deklarierte Höhenbezüge werden weiterhin abgelehnt. Nicht erkannte Namen, die sich nicht abgleichen lassen, werden ebenfalls abgelehnt. Laden Sie die Föderation neu oder richten Sie sie erneut aus, um Änderungen anzuwenden.',
  'settings.ifcFederation.assumed': 'Angenommenes Höhensystem',
  'settings.ifcFederation.appliedUnresolved': 'Gemäß Ihrer Einstellung wird angenommen, dass die IFC-Höhen das Höhensystem des Ankermodells verwenden. Ein erfasster Höhenbezug konnte nicht aufgelöst werden; die Quelldeklarationen bleiben unverändert.',
  'settings.ifcFederation.applied': 'Gemäß Ihrer Einstellung wird angenommen, dass die IFC-Höhen das Höhensystem des Ankermodells verwenden. Ein Höhenbezug fehlt; die Quelldeklarationen bleiben unverändert.',
} satisfies Catalogue;
