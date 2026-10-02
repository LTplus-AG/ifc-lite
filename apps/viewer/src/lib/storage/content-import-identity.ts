/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ContentKind } from './content-database.js';

/** New import identities carry provenance into the first native library write. */
const identities = new Map<string, string>();
const key = (kind: ContentKind, id: string) => `${kind}:${id}`;
export function rememberImportIdentity(kind: ContentKind, id: string, fingerprint: string): void {
  identities.set(key(kind, id), fingerprint);
}
export function contentImportIdentity(kind: ContentKind, id: string): string | undefined {
  return identities.get(key(kind, id));
}
export function forgetImportIdentity(kind: ContentKind, id: string, fingerprint?: string): void {
  if (identities.get(key(kind, id)) === fingerprint) identities.delete(key(kind, id));
}
