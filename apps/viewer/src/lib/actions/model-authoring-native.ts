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

import { profileInMetres } from './model-authoring-shape-params';
import { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { copyBatchInStore, addHostedElementInStore, addOrdinaryElementInStore, resolveSpatialAnchor, type OrdinaryInStoreElement } from '@ifc-lite/create';
import { createModellingStoreBackend, resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import { ensureStoreyPlacement } from '@/store/slices/storeyPlacement';
import type { HostedFillSpec } from '@/store/slices/mutation-hosted-fill';
import type { ModellingMethods } from '@/store/slices/mutation-modelling-records';
import { draftElementSize } from '@/lib/element-size-commit';
import { writeElementProfile } from '@/store/slices/mutation-element-profile';
import { sizeInMetres } from './model-authoring-size-params';
import { authoringCopyTransforms, copyRefs } from './model-authoring-copy';
