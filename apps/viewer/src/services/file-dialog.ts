/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface GenericFileDialogOptions {
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/**
 * Browser-only build: there is no native OS file dialog, so this resolves to
 * `null` and callers fall back to a browser `<input type="file">`. (ifc-lite no
 * longer ships a desktop app; third parties building their own desktop shell on
 * the published packages supply native file access in their own host layer.)
 */
export async function openGenericFileDialog(_options: GenericFileDialogOptions = {}): Promise<null> {
  return null;
}
