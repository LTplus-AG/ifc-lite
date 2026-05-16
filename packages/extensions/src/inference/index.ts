/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {
  inferCapabilities,
  type InferenceResult,
  type InferenceObservation,
  type InferenceParseError,
} from './capability.js';
export {
  INFERENCE_CATALOGUE,
  lookupNamespaceMethod,
  isKnownNamespace,
  type NamespaceMapping,
} from './catalogue.js';
