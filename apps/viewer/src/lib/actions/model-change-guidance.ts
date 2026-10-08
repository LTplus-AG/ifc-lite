/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


/** Shared data-change schema plus the viewer's native authoring contract. */
import { MODEL_DATA_CHANGE_OUTPUT_GUIDANCE } from '@ifc-lite/ai/artifacts';
import { MODEL_AUTHORING_OUTPUT_GUIDANCE } from './model-authoring-guidance';

export const MODEL_CHANGE_OUTPUT_GUIDANCE = MODEL_DATA_CHANGE_OUTPUT_GUIDANCE + MODEL_AUTHORING_OUTPUT_GUIDANCE;
