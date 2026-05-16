/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { parseWhen } from './parse.js';
export {
  evaluateWhen,
  WHEN_CONTEXT_KEYS,
  EMPTY_WHEN_CONTEXT,
  type WhenContextKey,
} from './eval.js';
