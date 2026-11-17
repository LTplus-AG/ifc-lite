/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const stairRailingDe = {
  'stairRailing.tool.stair': 'Treppe',
  'stairRailing.tool.railing': 'Geländer',
  'stairRailing.stair.label': 'Treppe',
  'stairRailing.railing.label': 'Geländer',
  'stairRailing.field.riser': 'Steigung',
  'stairRailing.field.tread': 'Auftritt',
  'stairRailing.field.waist': 'Laufplatte',
  'stairRailing.inspector.RiserHeight': 'Steigungshöhe',
  'stairRailing.inspector.TreadLength': 'Auftrittslänge',
  'stairRailing.inspector.WaistThickness': 'Laufplattendicke',
  'stairRailing.inspector.effect': 'Der Antritt und die Anzahl der Steigungen bleiben fest. Die Steigungshöhe ändert die Gesamthöhe; die Auftrittslänge ändert die Gesamtlauflänge.',
  'stairRailing.field.postSpacing': 'Pfosten',
  'stairRailing.stair.hintStart': 'Klicken Sie auf den Fuß der ersten Steigung · geben Sie eine Länge ein, um den Lauf festzulegen',
  'stairRailing.stair.hintEnd': 'Klicken oder Enter, um die Treppe zu platzieren · Länge eingeben, Tab für Winkel, Steigung, Auftritt · Rücktaste beginnt neu · Esc beendet',
  'stairRailing.stair.tooShort': 'Der Lauf ist zu kurz: Auftritte unter 0,1 m ergeben keine Treppe. Zeichnen Sie ihn länger oder wählen Sie eine höhere Steigung für weniger Stufen',
  'stairRailing.stair.waistTooThick': 'Die Laufplatte ist für einen Lauf dieser Höhe zu dick: Geben Sie eine dünnere ein',
  'stairRailing.stair.risers': {
    one: '{countDisplay} Steigung · bis {storey}',
    other: '{countDisplay} Steigungen · bis {storey}',
  },
  'stairRailing.stair.risersFree': {
    one: '{countDisplay} Steigung · kein Geschoss darüber',
    other: '{countDisplay} Steigungen · kein Geschoss darüber',
  },
  'stairRailing.railing.hintStart': 'Klicken Sie, um das Geländer zu beginnen · fängt an Deckenkanten und Treppenseiten · geben Sie eine Länge ein, um sie festzulegen',
  'stairRailing.railing.hintNext': 'Klicken fügt einen Punkt hinzu · Doppelklick oder Enter beendet · Rücktaste entfernt einen Punkt · Esc beginnt neu',
  'stairRailing.railing.needTwo': 'Ein Geländer benötigt mindestens zwei Punkte',
  'stairRailing.railing.summary': {
    one: '{countDisplay} Punkt · {length}',
    other: '{countDisplay} Punkte · {length}',
  },
  'stairRailing.railing.finish': 'Fertigstellen',
  'stairRailing.railing.finishTitle': 'Geländer entlang der bisherigen Punkte platzieren (Enter)',
  'commandPalette.tool.stair.label': 'Treppen zeichnen',
  'commandPalette.tool.railing.label': 'Geländer zeichnen',
  'commands.model.stair': 'Treppe bis zum Geschoss darüber zeichnen (Modell-Arbeitsbereich)',
  'commands.model.railing': 'Geländer entlang eines Pfads zeichnen (Modell-Arbeitsbereich)',
} satisfies Catalogue;
