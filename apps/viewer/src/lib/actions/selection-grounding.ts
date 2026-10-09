/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The current selection as bounded, model-resolved grounding: GlobalId, model,
 * IFC class and Name for each selected element. A pure read of the store — it
 * uploads nothing. Callers decide whether to attach it: the Assistant composer
 * attaches it only when the user asks, and an evidence adapter can embed it as
 * rows (each element carries `globalId` + `modelId`, the identity scene-action
 * citations resolve by).
 */

import { nativeGridEvidence, type NativeGridEvidence } from './native-grid-evidence';
import { nativeAuthoringEvidence, type NativeAuthoringEvidence } from './native-authoring-evidence';
