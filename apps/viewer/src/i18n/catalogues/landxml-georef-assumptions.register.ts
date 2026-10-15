/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { registerEnglish } from '../registry';
import { landXmlGeorefAssumptionsEn } from './landxml-georef-assumptions.en';

// Imported by the lazy LandXML georeferencing-assumption UI (refusal prompt,
// Settings group, "Assumed" notice), so these strings are not in the eager bundle.
registerEnglish(landXmlGeorefAssumptionsEn);
