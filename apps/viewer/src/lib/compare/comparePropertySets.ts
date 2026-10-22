/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypeEntityOwnProperties,
  extractTypeEntityOwnQuantities,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { isTypeObjectClass } from './typeObjectTag.js';

export type ExtractedPropertySets = ReturnType<typeof extractPropertiesOnDemand>;

/** The same own-data projection for fingerprints and change details.
 * Types attach definitions directly through HasPropertySets, unlike products
 * whose definitions arrive through relationships (#8040). The type extractors
 * also include relationship-attached sets without double-counting them. */
export function compareProperties(store: IfcDataStore, localId: number): ExtractedPropertySets {
  return isTypeObjectClass(store.entities.getTypeName(localId))
    ? extractTypeEntityOwnProperties(store, localId)
    : extractPropertiesOnDemand(store, localId);
}

export function compareQuantities(store: IfcDataStore, localId: number) {
  return isTypeObjectClass(store.entities.getTypeName(localId))
    ? extractTypeEntityOwnQuantities(store, localId)
    : extractQuantitiesOnDemand(store, localId);
}
