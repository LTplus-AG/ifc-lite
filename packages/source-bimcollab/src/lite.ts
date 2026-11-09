/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The parts a host needs synchronously, before any BIMcollab request: the
 * manifest and the pure session helpers. Importing only this keeps the
 * provider, transports and fallback out of a host's eager bundle; load the
 * main entry lazily when the source is first used.
 */
export { BIMCOLLAB_MANIFEST } from './manifest.js';
export { spaceIdFromAccessToken, spaceLabelFromServerUrl, isBimcollabServerUrl } from './session.js';
