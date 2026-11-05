/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const toursIt = {
  'tours.learnTab.description':
    'Le guide interattive si svolgono sul tuo modello o sul progetto dimostrativo incluso. Ogni passaggio può essere saltato.',
  'tours.learnTab.completedAriaLabel': 'Completato',
  'tours.learnTab.replay': 'Ripeti',
  'tours.learnTab.start': 'Avvia',
  'tours.learnTab.minutes': '{count} min',
  'tours.panelTourButton.startAriaLabel': 'Avvia la guida: {title}',
  'tours.panelTourButton.tooltip': '{title} (guida di {count} min)',
  'tours.tourHost.prereqAriaLabel': '{title}: prerequisiti',
  'tours.tourHost.prereqLayerStack': 'Questa guida richiede uno stack di layer composto. Carica lo stack dimostrativo (tre piccoli layer) per seguirla.',
  'tours.tourHost.prereqSecondModel': 'Questa guida richiede due revisioni caricate di un modello. Carica il progetto dimostrativo per seguirla.',
  'tours.tourHost.prereqModel': 'Questa guida richiede un modello caricato. Carica il progetto dimostrativo per seguirla, oppure apri prima un tuo file IFC.',
  'tours.tourHost.cancel': 'Annulla',
  'tours.tourHost.loadDemoStack': 'Carica lo stack dimostrativo',
  'tours.tourHost.loadDemoProject': 'Carica il progetto dimostrativo',
  'tours.tourInvite.prompt': 'Sei nuovo qui?',
  'tours.tourInvite.start': 'Segui la guida di due minuti',
  'tours.tourInvite.dismissAriaLabel': 'Ignora l’invito alla guida',
  'tours.tourStepCard.ariaLabel': 'Passaggio {step} di {total} della guida: {title}',
  'tours.tourStepCard.endTourAriaLabel': 'Termina la guida',
  'tours.tourStepCard.redockedNotice': 'Per questo passaggio il pannello è stato riagganciato alla barra laterale.',
  'tours.tourStepCard.stuckHint': 'Bloccato? Salta questo passaggio e continua.',
  'tours.tourStepCard.skipStep': 'Salta passaggio',
  'tours.tourStepCard.skipUseDemo': 'Salta (usa la demo)',
  'tours.tourStepCard.done': 'Fine',
  'tours.tourStepCard.next': 'Avanti',
} satisfies Catalogue;
