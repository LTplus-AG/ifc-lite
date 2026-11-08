/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const toursDe = {
  'tours.learnTab.description':
    'Interaktive Rundgänge laufen mit Ihrem Modell oder dem mitgelieferten Demoprojekt. Jeder Schritt kann übersprungen werden.',
  'tours.learnTab.completedAriaLabel': 'Abgeschlossen',
  'tours.learnTab.replay': 'Wiederholen',
  'tours.learnTab.start': 'Starten',
  'tours.learnTab.minutes': '{count} Min.',
  'tours.panelTourButton.startAriaLabel': 'Rundgang starten: {title}',
  'tours.panelTourButton.tooltip': '{title} ({count}-minütiger Rundgang)',
  'tours.tourHost.prereqAriaLabel': '{title}: Voraussetzungen',
  'tours.tourHost.prereqLayerStack': 'Dieser Rundgang benötigt einen zusammengesetzten Ebenenstapel. Laden Sie den Demostapel (drei kleine Ebenen), um mitzumachen.',
  'tours.tourHost.prereqSecondModel': 'Dieser Rundgang benötigt zwei geladene Revisionen eines Modells. Laden Sie das Demoprojekt, um mitzumachen.',
  'tours.tourHost.prereqModel': 'Dieser Rundgang benötigt ein geladenes Modell. Laden Sie das Demoprojekt, um mitzumachen, oder öffnen Sie zuerst Ihre eigene IFC-Datei.',
  'tours.tourHost.cancel': 'Abbrechen',
  'tours.tourHost.loadDemoStack': 'Demostapel laden',
  'tours.tourHost.loadDemoProject': 'Demoprojekt laden',
  'tours.tourInvite.start': 'Zweiminütigen Rundgang starten',
  'tours.tourInvite.dismissAriaLabel': 'Einladung zum Rundgang schließen',
  'tours.tourStepCard.ariaLabel': 'Rundgangschritt {step} von {total}: {title}',
  'tours.tourStepCard.endTourAriaLabel': 'Rundgang beenden',
  'tours.tourStepCard.redockedNotice': 'Der Bereich wurde für diesen Schritt wieder in die Seitenleiste angedockt.',
  'tours.tourStepCard.stuckHint': 'Kommen Sie nicht weiter? Überspringen Sie diesen Schritt und machen Sie weiter.',
  'tours.tourStepCard.skipStep': 'Schritt überspringen',
  'tours.tourStepCard.skipUseDemo': 'Überspringen (Demo verwenden)',
  'tours.tourStepCard.done': 'Fertig',
  'tours.tourStepCard.next': 'Weiter',
} satisfies Catalogue;
