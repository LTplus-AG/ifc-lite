/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const placementPanelIt = {
  'placementPanel.title': 'Posizionamento',
  'placementPanel.headerCloseTitle': 'Chiudi il pannello di posizionamento',
  'placementPanel.tabs.local': 'Locale',
  'placementPanel.tabs.georeference': 'Georeferenziazione',
  'placementPanel.local.emptyTitle': 'Nessun modello selezionato',
  'placementPanel.local.emptyHint': 'Scegli i modelli da spostare, poi avvia il riposizionamento.',
  'placementPanel.local.startButton': 'Avvia riposizionamento',
  'placementPanel.georeference.emptyTitle': 'Nessun modello georeferenziato',
  'placementPanel.georeference.emptyHint': 'Carica un modello con una conversione cartografica (IfcMapConversion) per modificarne qui l’ancoraggio al sito.',
  'placementPanel.georeference.editToggleOn': 'Modifica in corso',
  'placementPanel.georeference.editToggleOff': 'Modifica ancoraggio',
  'placementPanel.georeference.startHint': 'Trascina il piano e la maniglia dell’altezza nella vista 3D, oppure sposta leggermente l’ancoraggio qui sotto.',
} satisfies Catalogue;
