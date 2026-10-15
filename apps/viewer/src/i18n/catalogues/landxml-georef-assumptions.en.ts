/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The two LandXML georeferencing assumptions a user can opt into: the
 * refusal prompt, the Settings group, and the "Assumed" notice on a model
 * placed under one. Lazy (#6923): registered by
 * `landxml-georef-assumptions.register.ts`, which only those three
 * lazy-loaded components import.
 */
export const landXmlGeorefAssumptionsEn = {
  'landXmlGeorefAssumptions.sharedVerticalDatum.label': 'Assume a shared height system',
  'landXmlGeorefAssumptions.sharedVerticalDatum.description': 'When the LandXML file or the model it is placed on does not say which height system its heights use, place the heights as written, as if both used the same one. If they do not, the surface sits too high or too low by the difference between the two height systems.',
  'landXmlGeorefAssumptions.epsgFromName.label': 'Read an EPSG code from the coordinate system name',
  'landXmlGeorefAssumptions.epsgFromName.description': 'When the LandXML CoordinateSystem gives no EPSG code but its name is exactly "EPSG:" followed by a number (for example EPSG:31467), use that code. Any other name is never read. If the name was only a label, the surface lands in the wrong place.',

  'landXmlGeorefAssumptions.title': 'LandXML file "{fileName}" could not be lined up with the model',
  'landXmlGeorefAssumptions.offer': 'It can be placed if you accept:',
  'landXmlGeorefAssumptions.load': 'Load with these assumptions',
  'landXmlGeorefAssumptions.always': 'Always assume this',
  'landXmlGeorefAssumptions.alwaysHint': '"Always assume this" also turns the checked assumptions on in Settings, General, for every later LandXML file. You can turn them off there again.',
  'landXmlGeorefAssumptions.cancel': 'Cancel',

  'landXmlGeorefAssumptions.settings': 'LandXML georeferencing',
  'landXmlGeorefAssumptions.settingsHint': 'Both are off by default: a LandXML file that does not say how it lines up with the model is refused, and the message names what is missing. Turn one on only if it holds for your files. A model placed this way is marked "Assumed".',

  'landXmlGeorefAssumptions.badge': 'Assumed',
  'landXmlGeorefAssumptions.assumed': 'Placed using assumptions you chose',
  'landXmlGeorefAssumptions.sharedVerticalDatum.applied': 'Heights assumed to share the anchor model\'s height system: no vertical datum is declared.',
  'landXmlGeorefAssumptions.epsgFromName.applied': '{crs} read from the CoordinateSystem name: no EPSG code is declared.',
} as const satisfies Record<string, TranslationValue>;
