/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const visibilityReasonsDe = {
  'visibilityEmpty.title': 'Nichts ist sichtbar: Die aktiven Filter schließen alle Bauteile aus.',
  'visibilityEmpty.reasons': 'Aktive Gründe: {reasons}',
  'visibilityEmpty.reset': 'Alles zurücksetzen',
  'visibilityReasons.hidden': 'Ausgeblendete Bauteile',
  'visibilityReasons.isolation': 'Isolierte Bauteile',
  'visibilityReasons.ghost': 'Röntgen-Kontext',
  'visibilityReasons.classFilter': 'Klassenfilter',
  'visibilityReasons.storey': 'Geschossfilter oder Solo-Ansicht',
  'visibilityReasons.exploded': 'Explodierte Geschosse',
  'visibilityReasons.modelHidden': 'Ausgeblendete Modelle',
  'visibilityReasons.lens': 'Aktive Linse',
  'visibilityReasons.typeVisibility': 'Ausgeblendete IFC-Klassen',
  'visibilityReasons.typeViewMode': 'Typenansicht',
  'visibilityReasons.hostTypes': 'Vom Host ausgeblendete Klassen',
  'visibilityReasons.section': 'Schnitt',
  'visibilityReasons.measurements': 'Messungen',
  'visibilityChips.hiddenCount': 'Ausgeblendete Bauteile · {count}',
  'visibilityChips.isolationCount': 'Isolierte Bauteile · {count}',
  'visibilityChips.ghostCount': 'Röntgen-Kontext · {count}',
  'visibilityChips.classFilterCount': 'Klassenfilter · {count}',
  'visibilityChips.storeyCount': 'Geschossfilter · {count}',
  'visibilityChips.soloCount': 'Solo · {count} Geschoss',
  'visibilityChips.soloCountPlural': 'Solo · {count} Geschosse',
  'visibilityChips.explodedGap': 'Explodiert · {gap} m Abstand',
  'visibilityChips.modelHiddenCount': 'Modell ausgeblendet · {hidden} von {total} Modellen',
  'visibilityChips.modelHiddenSingleCount': 'Modell ausgeblendet · {hidden} von {total} Modell',
  'visibilityChips.typeVisibilityCount': 'Ausgeblendete IFC-Klassen · {count}',
  'visibilityChips.hostTypesCount': 'Vom Host ausgeblendete Klassen · {count}',
  'visibilityChips.clearAriaLabel': '{reason} aufheben',
  'visibilityChips.keptTooltip': 'Alle anzeigen behält diese Einstellung bei. Ändern Sie sie im zugehörigen Steuerelement.',
  'visibilityChips.resetEverything': 'Alles zurücksetzen',
} satisfies Catalogue;
