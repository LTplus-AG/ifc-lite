/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type {
  Flavor,
  FlavorExtension,
  FlavorAuthor,
  FlavorSnapshot,
  KeybindingOverride,
  LayoutOverride,
  PromptOverlay,
  SavedLens,
  SavedQuery,
} from './types.js';
export { validateFlavor } from './schema.js';
export {
  diffFlavors,
  type FlavorDiff,
  type ExtensionDiff,
  type ListDiff,
  type SettingsDiff,
  type PromptOverlayDiff,
} from './diff.js';
export {
  mergeFlavors,
  type MergeConflict,
  type MergeResult,
} from './merge.js';
export {
  InMemoryFlavorStorage,
  type FlavorStorage,
  type FlavorStorageOptions,
} from './storage.js';
export {
  packFlavor,
  unpackFlavor,
  type FlavorPackOptions,
  type UnpackedFlavor,
} from './packer.js';
export {
  clampOverlay,
  overlayParagraphDiff,
  type OverlayClampOptions,
  type ClampedOverlay,
} from './overlay.js';
