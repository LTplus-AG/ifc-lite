/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const structuralDeriveDe = {
  "structuralDerive.hint": "Träger, Stützen und Stäbe werden zu Stabelementen, Decken und Wände zu Flächenelementen in ihrer Mittelebene; zusammentreffende Stabenden teilen einen Knoten; Fundamente tragen Auflager. Jedes abgeleitete Element ist mit seinem physischen Bauteil verknüpft. Hier werden IFC-Datensätze erstellt; die Bemessung wird nicht geprüft.",
  "structuralDerive.prepare": "Ableiten und prüfen",
  "structuralDerive.acknowledgement": "Ich habe die übersprungenen Bauteile und die angenommenen Auflager geprüft.",
  "structuralDerive.counts": "{curveMembers} Stabelemente · {surfaceMembers} Flächenelemente · {nodes} Knoten · {supports} Auflager, davon {guessedSupports} angenommen · {created} zu erstellende IFC-Datensätze",
  "structuralDerive.assumed": "{count} Bauteile haben keinen LoadBearing-Wert und gelten als tragend.",
  "structuralDerive.skipped": "Übersprungene Bauteile ({count})",
  "structuralDerive.guessed": "Angenommene Auflager an den tiefsten Knoten, da kein Fundament einen trägt ({count})",
  "structuralDerive.unconnected": "Knoten, die einen Stab oder eine Fläche berühren, ohne verbunden zu sein ({count})",
  "structuralDerive.existing": "Dieses Modell hat bereits ein Analysemodell ({ids}). Daneben wird nichts abgeleitet.",
  "structuralDerive.nothing": "Nichts abzuleiten: Kein tragendes Bauteil ließ sich idealisieren, oder jedes hat bereits ein statisches Gegenstück.",
  "structuralDerive.noModel": "Laden Sie ein Modell, um sein statisches Analysemodell abzuleiten.",
  "structuralDerive.nodeAt": "Knoten {node}: {position} m",
  "structuralDerive.endAt": "Knoten {node}: {position} m, {landsOn} #{element}",
  "structuralDerive.more": "{count} weitere nicht abgebildet",
  "structuralDerive.model": "Modell: {name}",
  "structuralDerive.moved": "Entlang ihrer Achse verschobene Stabenden, um einen Anschluss zu bilden ({count})",
  "structuralDerive.movedRow": "#{element} {end}: {distance} m bis #{to}",
  "structuralDerive.free": "Freie Stabenden ohne anderen Stab und ohne Auflager ({count})",
  "structuralDerive.end.start": "Anfang",
  "structuralDerive.end.end": "Ende",
  "structuralDerive.reason.already-idealised": "hat bereits ein statisches Gegenstück",
  "structuralDerive.reason.not-load-bearing": "nicht tragend",
  "structuralDerive.reason.load-bearing-unknown": "kein LoadBearing-Wert",
  "structuralDerive.reason.no-idealisable-shape": "Form lässt sich nicht idealisieren",
  "structuralDerive.reason.shorter-than-tolerance": "kürzer als die Toleranz",
  "structuralDerive.reason.footing-without-member-end": "kein Stabende auf diesem Fundament",
  "structuralDerive.landsOn.member-interior": "auf Stab",
  "structuralDerive.landsOn.surface-member": "auf Flächenelement",
} satisfies Catalogue;
