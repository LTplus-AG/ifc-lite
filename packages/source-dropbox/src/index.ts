/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { DropboxProvider } from './provider.js';
export { DROPBOX_MANIFEST } from './manifest.js';
export { REDIRECT_PATH } from './auth.js';
// `OAUTH_CALLBACK_CHANNEL` / `OAuthCallbackMessage` are deliberately NOT
// re-exported here. They belong to `@ifc-lite/oauth-pkce`, which owns the
// popup-callback mechanism and publishes them itself; a host that serves the
// callback route should import them from there. Publishing the same two names
// from two packages would make them impossible to remove later without a
// breaking change on both.
