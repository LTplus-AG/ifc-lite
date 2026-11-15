/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Authoring-tool CRS labels that are explicit aliases, never inferred coordinates. */
const WELL_KNOWN_CRS: Record<string, string> = {
  'wgs 84': '4326', 'wgs84': '4326', 'wgs-84': '4326', 'nad83': '4269', 'nad27': '4267', 'etrs89': '4258',
  'gcs_wgs_1984': '4326', 'gcs_north_american_1983': '4269',
  'rd': '28992', 'rd new': '28992', 'amersfoort / rd new': '28992', 'amersfoort rd new': '28992',
  'stelsel van de rijksdriehoeksmeting': '28992', 'rijksdriehoeksmeting': '28992', 'nl_rd': '28992',
  'rd new + nap height': '7415', 'amersfoort / rd new + nap height': '7415',
  'osgb 1936 / british national grid': '27700', 'osgb36 / british national grid': '27700',
  'british national grid': '27700', 'bng': '27700',
  'dhdn / gauss-kruger zone 2': '31466', 'dhdn / gauss-kruger zone 3': '31467',
  'dhdn / gauss-kruger zone 4': '31468', 'dhdn / gauss-kruger zone 5': '31469',
  'etrs89 / utm zone 32n': '25832', 'etrs89 / utm zone 33n': '25833',
  'mgi / austria lambert': '31287', 'austria lambert': '31287',
  'ch1903+ / lv95': '2056', 'lv95': '2056', 'ch1903 / lv03': '21781', 'lv03': '21781',
  'belge 1972 / belgian lambert 72': '31370', 'belgian lambert 72': '31370',
  'etrs89 / belgian lambert 2008': '3812',
  'rgf93 / lambert-93': '2154', 'rgf93 v1 / lambert-93': '2154', 'lambert-93': '2154', 'lambert 93': '2154',
};

export function wellKnownCrsCode(name: string): string | undefined {
  return WELL_KNOWN_CRS[name.trim().toLowerCase()];
}
