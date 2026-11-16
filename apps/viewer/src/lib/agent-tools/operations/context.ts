/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerOperationContext } from './contract';
/** The main viewer SDK exists before the first model; do not synthesize a model to reach it. */
export function viewerSdk(context: ViewerOperationContext) {
  const bim = context.host.bim;
  if (!bim) throw new Error('The viewer SDK is not attached to this operation host.');
  return bim;
}
