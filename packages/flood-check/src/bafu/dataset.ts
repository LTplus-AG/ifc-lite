/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BAFU surface-runoff hazard map ("Gefährdungskarte Oberflächenabfluss"):
 * legend, classes, and the texts every surface showing a result must show.
 *
 * Sources, retrieved 2026-11-15:
 * - Legend PNG https://api3.geo.admin.ch/static/images/legends/ch.bafu.gefaehrdungskarte-oberflaechenabfluss_de.png
 *   (its five swatches are exactly the colours below) and Table 1 of the
 *   technical report linked in {@link BAFU_TECHNICAL_REPORT_URL}.
 * - Abstracts: WMS GetCapabilities on https://wms.geo.admin.ch/ with LANG=de
 *   and LANG=en, layer ch.bafu.gefaehrdungskarte-oberflaechenabfluss; the
 *   English text is identical to the STAC collection description at
 *   https://data.geo.admin.ch/api/stac/v1/collections/ch.bafu.gefaehrdungskarte-oberflaechenabfluss
 *   (which has no German variant).
 * - Dataset date: STAC temporal extent 2018-05-22; metadata updated 2026-03-19.
 */

import type { LegendEntry } from '../legend.js';
import type { HazardClassDefinition, LocalizedText, MapBBox } from '../types.js';

export const BAFU_LAYER = 'ch.bafu.gefaehrdungskarte-oberflaechenabfluss';
export const BAFU_WMS_URL = 'https://wms.geo.admin.ch/';
export const BAFU_CRS = 'EPSG:2056';
export const BAFU_DATASET_DATE = '2018-05-22';
export const BAFU_METADATA_UPDATED = '2026-03-19';
export const BAFU_INFO_URL = 'https://www.bafu.admin.ch/en/surface-runoff';
export const BAFU_TECHNICAL_REPORT_URL =
  'https://www.bafu.admin.ch/dam/en/sd-web/DEm7R2xCdfPk/gefaehrdungskarte-oberflaechenabfluss-schweiz-technischer-bericht.pdf';
export const BAFU_TERMS_URL = 'https://www.geo.admin.ch/en/general-terms-of-use-fsdi';
/** Layer bounding box in EPSG:2056 from the WMS capabilities. */
export const BAFU_EXTENT: MapBBox = { minX: 2_300_000, minY: 900_000, maxX: 3_100_000, maxY: 1_450_000 };
/**
 * Reference location for the rendering check: a 9 m x 9 m box in Bern where
 * the map shows flow depth 0 to 0.1 m in every pixel (recorded 2026-11-15 as
 * `test/fixtures/bafu/bern-uniform-9px.png`: 81 of 81 pixels depth-0-0.1).
 * One 9 x 9 px request, about 80 bytes.
 */
export const BAFU_REFERENCE_BOX: MapBBox = { minX: 2_599_560, minY: 1_199_720, maxX: 2_599_569, maxY: 1_199_729 };
export const BAFU_REFERENCE_CELL_SIZE = 1;
/** The hazard model's raster resolution (technical report). */
export const BAFU_MODEL_CELL_SIZE = 1;
/** Most detailed scale the publisher allows the map to be used at (1:10,000 in Liechtenstein). */
export const BAFU_SCALE_LIMIT_DENOMINATOR = 12_500;

export const BAFU_CLASSES: readonly HazardClassDefinition[] = [
  {
    id: 'depth-0-0.1',
    kind: 'depth',
    lowerBound: 0,
    upperBound: 0.1,
    label: { de: 'Fliesstiefe 0 < h ≤ 0.1 m', en: 'Flow depth 0 < h ≤ 0.1 m' },
  },
  {
    id: 'depth-0.1-0.25',
    kind: 'depth',
    lowerBound: 0.1,
    upperBound: 0.25,
    label: { de: 'Fliesstiefe 0.1 < h ≤ 0.25 m', en: 'Flow depth 0.1 < h ≤ 0.25 m' },
  },
  {
    id: 'depth-gt-0.25',
    kind: 'depth',
    lowerBound: 0.25,
    upperBound: null,
    label: { de: 'Fliesstiefe h > 0.25 m', en: 'Flow depth h > 0.25 m' },
  },
  {
    id: 'watercourse',
    kind: 'watercourse',
    lowerBound: 0,
    upperBound: null,
    label: { de: 'Gewässer', en: 'Watercourse' },
  },
  {
    id: 'glacier',
    kind: 'excluded',
    lowerBound: 0,
    upperBound: null,
    label: { de: 'Gletscher', en: 'Glacier' },
  },
];

/** Legend colours; transparent means no runoff modelled. */
export const BAFU_LEGEND: readonly LegendEntry[] = [
  { rgb: [255, 189, 255], classId: 'depth-0-0.1' },
  { rgb: [223, 115, 255], classId: 'depth-0.1-0.25' },
  { rgb: [132, 0, 168], classId: 'depth-gt-0.25' },
  { rgb: [0, 166, 255], classId: 'watercourse' },
  { rgb: [222, 245, 255], classId: 'glacier' },
];

export const BAFU_TITLE: LocalizedText = {
  de: 'Gefährdungskarte Oberflächenabfluss',
  en: 'Overland flow map',
};

/** The layer abstract, verbatim (including the publisher's spelling). */
export const BAFU_DISCLAIMER: LocalizedText = {
  de:
    'Die in der Gefährdungskarte Oberflächenabfluss dargestellten Überschwemmungsgebiete wurden über das gesamte Gebiet der Schweiz und von Liechtenstein mit einer einheitlichen Methode erstellt. ' +
    'Sie beruhen auf einer Modellierung ohne Verifizierung oder Plausibilisierung im Gelände. ' +
    'Sie kennzeichnen diejenigen Gebiete, die bei seltenen bis sehr seltenen Ereignissen potenziell betroffen sind. ' +
    'Sie geben eine grobe Gesamtübersicht über die Gefährdung durch Oberflächenabfluss. ' +
    'Sie kennzeichnen nicht die Gebiete, die durch Überschwemmung aus Fliessgewässern betroffen sind und berücksichtigen keine Schutzbauten oder Strassenunterführungen oder Durchlässe in Bahndämmen (so erscheinen bspw. SBB-Dämme im DTM als durchgehender Damm ohne Durchlass). ' +
    'Diese Karte erlaubt eine Grobaschätzung über die Gefährdung durch Oberflächenabfluss, sofern keine detaillierte Gefahrenkarte vorhanden ist. ' +
    'Die geschätzte Wiederkehrperiode ist grösser als 100 Jahre, das heisst, dass über lange Sicht gesehen ein solches Ereignis im Mittel einmal in hundert Jahren auftritt. ' +
    'Es ist nicht auszuschliessen, dass Oberflächenabfluss auch auf Flächen auftritt, die in der Karte als nicht betroffen erscheinen. ' +
    'Sie darf nicht in einem Massstab verwendet werden, der detaillierter als 1:12`500 (Liechtenstein: 1: 10`000) ist, um Fehler in der Interpretation von betroffenen und nicht betroffenen Gebieten zu vermeiden. ' +
    'Die Karte hat keine Rechtsverbindlichkeit, es steht aber den Kantonen frei, sie als Gefahrenhinweiskarte in ihre Gefahrengrundlagen zu übernehmen und sie im kantonalen Geoportal zu publizieren.',
  en:
    'The areas affected by overland flow were determined using a simplified method the over entire Switzerland and Liechtenstein. ' +
    'They were determined by modelling without any verification in the field. ' +
    'The map shows areas that are potentially affected by rare to very rare events. ' +
    'It provides a rough overview of the hazard of overland flow. ' +
    'It does neither take into account flooding due to overflowing watercourses, nor due to protective structures or culverts under roads or embankments (e.g. railway embankment appear according to the DTM as dykes without vaults). ' +
    'This map allows - in the absence of a more detailed hazard map - a rough assessment of the hazardous overland flow. ' +
    'The return period of the event represented is estimated to be larger than 100 years - an event that, over a long period of observation, would appear on average once every 100 years. ' +
    'It cannot be ruled out that areas not affected by the hazard map may be affected. ' +
    'It has to be used on a scale coarser than 1: 12,500 (Liechtenstein: 1:10,000) because of the potential for misinterpretation of affected and unaffected areas respectively. ' +
    'The map is not legally binding. ' +
    'The cantons are free to use it as an indicative hazard map and publish it on their cantonal geoportals.',
};

/** The return-period sentence of the abstract, verbatim. */
export const BAFU_RETURN_PERIOD: LocalizedText = {
  de: 'Die geschätzte Wiederkehrperiode ist grösser als 100 Jahre, das heisst, dass über lange Sicht gesehen ein solches Ereignis im Mittel einmal in hundert Jahren auftritt.',
  en: 'The return period of the event represented is estimated to be larger than 100 years - an event that, over a long period of observation, would appear on average once every 100 years.',
};

/**
 * The stated limits, one per entry. The first seven are sentences of the
 * abstract, verbatim; the last two restate the technical report's modelling
 * notes and the cantonal-terms caveat.
 */
export const BAFU_LIMITS: readonly LocalizedText[] = [
  {
    de: 'Sie beruhen auf einer Modellierung ohne Verifizierung oder Plausibilisierung im Gelände.',
    en: 'They were determined by modelling without any verification in the field.',
  },
  {
    de: 'Sie kennzeichnen nicht die Gebiete, die durch Überschwemmung aus Fliessgewässern betroffen sind und berücksichtigen keine Schutzbauten oder Strassenunterführungen oder Durchlässe in Bahndämmen (so erscheinen bspw. SBB-Dämme im DTM als durchgehender Damm ohne Durchlass).',
    en: 'It does neither take into account flooding due to overflowing watercourses, nor due to protective structures or culverts under roads or embankments (e.g. railway embankment appear according to the DTM as dykes without vaults).',
  },
  BAFU_RETURN_PERIOD,
  {
    de: 'Es ist nicht auszuschliessen, dass Oberflächenabfluss auch auf Flächen auftritt, die in der Karte als nicht betroffen erscheinen.',
    en: 'It cannot be ruled out that areas not affected by the hazard map may be affected.',
  },
  {
    de: 'Sie darf nicht in einem Massstab verwendet werden, der detaillierter als 1:12`500 (Liechtenstein: 1: 10`000) ist, um Fehler in der Interpretation von betroffenen und nicht betroffenen Gebieten zu vermeiden.',
    en: 'It has to be used on a scale coarser than 1: 12,500 (Liechtenstein: 1:10,000) because of the potential for misinterpretation of affected and unaffected areas respectively.',
  },
  {
    de: 'Die Karte hat keine Rechtsverbindlichkeit, es steht aber den Kantonen frei, sie als Gefahrenhinweiskarte in ihre Gefahrengrundlagen zu übernehmen und sie im kantonalen Geoportal zu publizieren.',
    en: 'The map is not legally binding.',
  },
  {
    de: 'Diese Karte erlaubt eine Grobaschätzung über die Gefährdung durch Oberflächenabfluss, sofern keine detaillierte Gefahrenkarte vorhanden ist.',
    en: 'This map allows - in the absence of a more detailed hazard map - a rough assessment of the hazardous overland flow.',
  },
  {
    de: 'Gebäude sind im Modell um 5 m erhöht, versiegelte Flächen um 0.25 m abgesenkt; Unterführungen, Durchlässe, Kanalisation, Randsteine, Mauern und alles nach dem Geländemodell Gebaute sind nicht abgebildet (technischer Bericht).',
    en: 'Buildings are raised 5 m in the model and paved areas lowered 0.25 m; underpasses, culverts, sewers, kerbs, walls and anything built after the terrain model are not represented (technical report).',
  },
  {
    de: 'Für Daten des Kantons Luzern gelten gesonderte kantonale Nutzungsbedingungen.',
    en: 'Data of the canton of Lucerne is subject to separate cantonal terms of use.',
  },
];

/** The mandatory source reference: author, title, link. */
export const BAFU_ATTRIBUTION =
  'Bundesamt für Umwelt BAFU / Federal Office for the Environment FOEN, ' +
  '«Gefährdungskarte Oberflächenabfluss / Overland flow map» (layer ch.bafu.gefaehrdungskarte-oberflaechenabfluss), ' +
  BAFU_INFO_URL;

export const BAFU_LICENCE =
  'Federal geodata under the geo.admin.ch terms of use, source reference mandatory (' + BAFU_TERMS_URL + '); ' +
  'the STAC collection states licence "proprietary"; canton of Lucerne data: separate cantonal terms.';
