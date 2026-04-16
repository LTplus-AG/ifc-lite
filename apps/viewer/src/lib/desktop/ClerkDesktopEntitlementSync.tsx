/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Desktop entitlement sync stub.
 *
 * This file exists as an override target for the desktop repo (Tauri shell).
 * The desktop build replaces it via path alias with its own implementation.
 * In the web viewer this is a no-op — entitlements are not used.
 */
export function ClerkDesktopEntitlementSync() {
  return null;
}
