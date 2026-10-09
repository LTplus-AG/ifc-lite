/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The native write of each reviewed authoring operation, in the two places it
 * runs: a preview DRY RUN against a draft of the model's overlay that is never
 * published (so the builders' own validation decides, with earlier operations
 * of the batch in place), and the commit through the store's gated actions.
 * Both reach the same `@ifc-lite/create` builders: `addOrdinaryElementInStore`
 * (the store's `addWall` & co.), `addHostedElementInStore` (`addHostedFill`),
 * and `bim.store`'s modelling methods for joins, types and materials.
 */

import { writeReviewedStoreyReassignment } from './model-authoring-storey-reassignment';
import { writeCurtainWallCreation } from './model-authoring-curtain-wall-native';
