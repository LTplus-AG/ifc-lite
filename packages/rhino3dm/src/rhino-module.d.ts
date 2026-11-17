/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #rhino-factory maps to the pinned ESM entry, which has the same API as the declared CommonJS entry.
declare module '#rhino-factory' {
  import factory from 'rhino3dm';
  export default factory;
}
