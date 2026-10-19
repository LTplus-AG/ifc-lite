/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export function createImportedGeometryKernel(): {
  memory: { readonly buffer: ArrayBuffer };
  imported_alloc(length: number): number;
  imported_free(pointer: number, length: number): void;
  imported_run(pointer: number, length: number): number;
};
