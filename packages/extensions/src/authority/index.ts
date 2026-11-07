/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { attributeSelectorPath, targetMatchesAttribute } from './attribute-path.js';
export {
  AUTHORITY_HEADER_KEY,
  parseCharter,
  findGoverningRule,
  type AttributeSubject,
  type Charter,
  type CharterRule,
} from './charter.js';
export {
  resolveAttribute,
  canonicalValueKey,
  type AttributeResolution,
  type AttributeState,
  type Opinion,
  type ResolveOptions,
} from './resolve.js';
