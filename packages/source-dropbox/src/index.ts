/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { DropboxProvider } from './provider.js';
export { DROPBOX_MANIFEST } from './manifest.js';
export { REDIRECT_PATH } from './auth.js';
// Exported so a host that serves the callback route (see
// `apps/viewer/public/oauth/dropbox/callback.html`) can name the same channel
// rather than re-deriving the string.
export { OAUTH_CALLBACK_CHANNEL } from './callback-channel.js';
export type { OAuthCallbackMessage } from './callback-channel.js';
