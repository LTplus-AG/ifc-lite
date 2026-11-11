/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const structuralPropertiesDe = {
  "properties.structural.heading": "Tragwerksanalyse",
  "properties.structural.relatedUnavailable": "Einige native Beziehungsziele haben fehlende oder doppelte GlobalIds und sind nicht eindeutig auflösbar. Diese Zeilen werden weggelassen; vollständige Gesamtzahlen sind unbekannt.",
  "properties.structural.sourceUnavailable": "Ohne IFC-Quelle können die ursprünglichen Tragwerksfelder und die vollständige Zugehörigkeit nicht geprüft werden. Verfügbare angegebene Felder werden angezeigt.",
  "properties.structural.loadsTruncatedTooltip": "Bei der Extraktion wurden eine oder mehrere Lasten begrenzt – dieser Stab kann mehr Lastdaten enthalten als angezeigt",
  "properties.structural.truncatedBadge": "Abgeschnitten",
  "properties.structural.predefined": "Vordefiniert",
  "properties.structural.model": "Modell",
  "properties.structural.connections": "Verbindungen ({countDisplay})",
  "properties.structural.appliedLoads": "Aufgebrachte Lasten ({countDisplay})",
  "properties.structural.analyticalItems": "Analytische Elemente ({countDisplay})",
  "properties.structural.physicalElements": "Physische Bauteile ({countDisplay})",
  "properties.structural.noDofs": "(keine Freiheitsgrade)",
  "properties.structural.fixedDofs": {"one": "{countDisplay} Freiheitsgrad festgehalten", "other": "{countDisplay} Freiheitsgrade festgehalten"},
  "properties.structural.elasticDofs": {"one": "{countDisplay} Freiheitsgrad elastisch", "other": "{countDisplay} Freiheitsgrade elastisch"},
  "properties.structural.freeDofs": {"one": "{countDisplay} Freiheitsgrad frei", "other": "{countDisplay} Freiheitsgrade frei"},
  "properties.structural.noComponents": "(keine Komponenten)",
  "properties.structural.componentValue": "{name}: {value}",
  "properties.structural.configurationDropped": "[weggelassen: {name}]",
  "properties.structural.configurationAt": "{components} @ {location}",
  "structuralGlyphs.support.fixed": "Einspannung",
  "structuralGlyphs.support.pinned": "Gelenkiges Lager",
  "structuralGlyphs.support.roller": "Verschiebliches Lager",
  "structuralGlyphs.support.spring": "Federlager",
  "structuralGlyphs.load.force": "Kraft",
  "structuralGlyphs.load.moment": "Moment",
  "structuralGlyphs.load.temperature": "Temperaturlast",
  "structuralGlyphs.load.displacement": "Auflagerverschiebung",
  "structuralGlyphs.tooltip": "{kind} · {entity}",
} satisfies Catalogue;
