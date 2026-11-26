/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { loadModelForDelivery as load } from '@ifc-lite/sdk/headless/delivery';
import { openModelInput } from '../model-input.js';

export function loadModelForDelivery(path: string): ReturnType<typeof load> {
  return load(path, openModelInput);
}
