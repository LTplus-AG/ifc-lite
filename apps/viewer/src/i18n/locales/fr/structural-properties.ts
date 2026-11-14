/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const structuralPropertiesFr = {
  'properties.structural.heading': 'Analyse structurelle',
  'properties.structural.relatedUnavailable': 'Certaines cibles de relations natives ont des GlobalId manquants ou en double et ne peuvent pas être résolues de façon unique. Ces lignes sont omises ; les totaux complets sont inconnus.',
  'properties.structural.sourceUnavailable': 'Les champs structurels d’origine et l’appartenance complète ne peuvent pas être vérifiés sans la source IFC. Les champs saisis disponibles sont affichés.',
  'properties.structural.loadsTruncatedTooltip':
    'Une ou plusieurs charges appliquées ont été limitées lors de l’extraction — cette barre peut porter plus de données de charge que celles affichées',
  'properties.structural.truncatedBadge': 'Tronqué',
  'properties.structural.predefined': 'Prédéfini',
  'properties.structural.model': 'Modèle',
  'properties.structural.connections': 'Connexions ({countDisplay})',
  'properties.structural.appliedLoads': 'Charges appliquées ({countDisplay})',
  'properties.structural.analyticalItems': 'Éléments analytiques ({countDisplay})',
  'properties.structural.physicalElements': 'Éléments physiques ({countDisplay})',
  'properties.structural.noDofs': '(aucun DDL)',
  'properties.structural.fixedDofs': { one: '{countDisplay} DDL bloqué', other: '{countDisplay} DDL bloqués' },
  'properties.structural.elasticDofs': { one: '{countDisplay} DDL élastique', other: '{countDisplay} DDL élastiques' },
  'properties.structural.freeDofs': { one: '{countDisplay} DDL libre', other: '{countDisplay} DDL libres' },
  'properties.structural.noComponents': '(aucune composante)',
  'properties.structural.componentValue': '{name} : {value}',
  'properties.structural.configurationDropped': '[ignoré : {name}]',
  'properties.structural.configurationAt': '{components} @ {location}',
} satisfies Catalogue;
