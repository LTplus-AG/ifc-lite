/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The words that go with every result. Each element result carries what its
 * outcome establishes (and what it does not) and the screening caveat, so a
 * result read on its own cannot be taken for a site assessment.
 */

import type { HazardProvenance, LocalizedText } from '../types.js';
import type { Outcome } from './outcome.js';

/** The name of the site-level property set every element payload points to. */
export const SITE_PSET = 'IfcLite_SurfaceRunoffHazardSite';

/** What each outcome establishes, and what it does not. */
export const OUTCOME_MEANING: Readonly<Record<Outcome, LocalizedText>> = {
  exposed: {
    en: 'At a ground sample next to the element, even the lowest water surface of the mapped depth class reaches the element level.',
    de: 'An einem Bodenpunkt neben dem Element erreicht schon der tiefste Wasserspiegel der kartierten Tiefenklasse die Höhe des Elements.',
  },
  'above-mapped-class-range': {
    en:
      'The element level lies above the highest water surface of every depth class mapped next to it, by at least the clearance margin. ' +
      'This is all it states: rarer events, and runoff the map does not show, are not covered.',
    de:
      'Die Höhe des Elements liegt um mindestens die Sicherheitsmarge über dem höchsten Wasserspiegel jeder daneben kartierten Tiefenklasse. ' +
      'Mehr sagt das nicht aus: seltenere Ereignisse und Abfluss, den die Karte nicht zeigt, sind nicht erfasst.',
  },
  'within-class-range': {
    en: 'The mapped depth class range cannot decide whether water reaches the element level.',
    de: 'Der Bereich der kartierten Tiefenklasse lässt nicht entscheiden, ob Wasser die Höhe des Elements erreicht.',
  },
  'open-ended-class': {
    en: 'A depth class without an upper bound (or a watercourse) is mapped next to the element; no level can be shown to lie above it.',
    de: 'Neben dem Element ist eine Tiefenklasse ohne Obergrenze (oder ein Gewässer) kartiert; keine Höhe kann als darüberliegend gelten.',
  },
  'no-runoff-mapped': {
    en:
      'The map shows no runoff on the ground sampled next to the element. This is NOT a statement that the element is safe: ' +
      'the publisher states that areas shown as unaffected may still be affected.',
    de:
      'Die Karte zeigt auf den Bodenpunkten neben dem Element keinen Abfluss. Das heisst NICHT, dass das Element sicher ist: ' +
      'gemäss Herausgeber können als nicht betroffen dargestellte Flächen dennoch betroffen sein.',
  },
  unclassified: {
    en:
      'Nothing is established for the element: the map or the terrain could not be read next to it, or a condition named in the ' +
      'reason (for example an unconfirmed height reference) withholds what the map shows there.',
    de:
      'Für das Element ist nichts festgestellt: Karte oder Gelände konnten daneben nicht gelesen werden, oder eine im Grund genannte ' +
      'Bedingung (zum Beispiel ein nicht bestätigter Höhenbezug) hält zurück, was die Karte dort zeigt.',
  },
};

/** The caveat every result and every element payload carries. */
export function screeningCaveat(p: HazardProvenance): LocalizedText {
  return {
    en:
      `Screening result from "${p.datasetTitle.en}" (dataset date ${p.datasetDate}), a map not intended for use at building scale; ` +
      `areas it shows as unaffected may still be affected. Disclaimer, limits and parameters: property set ${SITE_PSET} on the site. ` +
      `Source: ${p.attribution}`,
    de:
      `Screening-Ergebnis aus «${p.datasetTitle.de}» (Datenstand ${p.datasetDate}), einer Karte, die nicht für den Gebäudemassstab bestimmt ist; ` +
      `als nicht betroffen dargestellte Flächen können dennoch betroffen sein. Hinweis, Grenzen und Parameter: Eigenschaftssatz ${SITE_PSET} am Grundstück. ` +
      `Quelle: ${p.attribution}`,
  };
}
