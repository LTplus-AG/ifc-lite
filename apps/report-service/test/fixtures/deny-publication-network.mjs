/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Fault containment for the actual service-process regression and its mutation:
// no GitHub fetch may leave this child, even if dummy credentials are changed.
// No successful response is fabricated; a real publisher attempt fails closed.
globalThis.fetch = async () => {
  throw new Error('owned dormant-publication fixture forbids outbound fetch');
};
