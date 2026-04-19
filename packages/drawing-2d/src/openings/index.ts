/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opening handling for architectural 2D drawings
 */

export { OpeningRelationshipBuilder } from './opening-relationship-builder.js';
export { OpeningFilter } from './opening-filter.js';
export {
  buildOpeningRelationships,
  getOpeningsForHost,
  getFillingElement,
  isOpeningElement,
  isDoorOrWindow,
} from './opening-utils.js';
