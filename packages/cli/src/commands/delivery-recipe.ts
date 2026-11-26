/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { loadDeliveryRecipe as load } from '@ifc-lite/sdk/headless/delivery';
import { fatal } from '../output.js';

export async function loadDeliveryRecipe(path: string): ReturnType<typeof load> {
  try {
    return await load(path);
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
}
