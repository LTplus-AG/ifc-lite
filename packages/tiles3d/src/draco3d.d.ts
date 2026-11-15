/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// draco3d ships no types; the reader narrows the module to DracoDecoderModule.
declare module 'draco3d' {
  export function createDecoderModule(options?: Record<string, unknown>): Promise<unknown>;
}
