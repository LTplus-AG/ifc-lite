/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const structuralPropertiesIt = {
  'properties.structural.heading': 'Analisi strutturale',
  'properties.structural.relatedUnavailable': 'Alcune destinazioni di relazione native hanno GlobalId mancanti o duplicati e non possono essere risolte in modo univoco. Queste righe sono omesse; i totali completi non sono noti.',
  'properties.structural.sourceUnavailable': 'Senza l’origine IFC non è possibile verificare i campi strutturali originali e l’appartenenza completa. Vengono mostrati i campi inseriti disponibili.',
  'properties.structural.loadsTruncatedTooltip':
    'Uno o più carichi applicati sono stati limitati durante l’estrazione: questo membro potrebbe avere più dati di carico di quelli mostrati',
  'properties.structural.truncatedBadge': 'Troncato',
  'properties.structural.predefined': 'Predefinito',
  'properties.structural.model': 'Modello',
  'properties.structural.connections': 'Connessioni ({countDisplay})',
  'properties.structural.appliedLoads': 'Carichi applicati ({countDisplay})',
  'properties.structural.noDofs': '(nessun grado di libertà)',
  'properties.structural.fixedDofs': {
    one: '{countDisplay} grado di libertà vincolato',
    many: '{countDisplay} gradi di libertà vincolati',
    other: '{countDisplay} gradi di libertà vincolati',
  },
  'properties.structural.elasticDofs': {
    one: '{countDisplay} grado di libertà elastico',
    many: '{countDisplay} gradi di libertà elastici',
    other: '{countDisplay} gradi di libertà elastici',
  },
  'properties.structural.freeDofs': {
    one: '{countDisplay} grado di libertà libero',
    many: '{countDisplay} gradi di libertà liberi',
    other: '{countDisplay} gradi di libertà liberi',
  },
  'properties.structural.noComponents': '(nessuna componente)',
  'properties.structural.componentValue': '{name}: {value}',
  'properties.structural.configurationDropped': '[scartato: {name}]',
  'properties.structural.configurationAt': '{components} @ {location}',
} satisfies Catalogue;
