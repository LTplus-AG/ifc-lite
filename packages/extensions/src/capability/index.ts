/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { parseCapability, parseCapabilities, isCapabilityScope } from './parse.js';
export { matchCapability, hasCapability, findGrant } from './match.js';
export {
  listCapabilityCatalogue,
  findCatalogueEntry,
  isKnownCapability,
  type CapabilityCatalogueEntry,
} from './catalogue.js';
export { computeRisk, computeRisks, overallTier } from './risk.js';
export { diffCapabilities, requiresReconsent } from './diff.js';
