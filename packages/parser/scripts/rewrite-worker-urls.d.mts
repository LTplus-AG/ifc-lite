/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Types for the build-time script, so `test/worker-url-specifiers-4895.test.ts`
 * can import its pure half under `allowJs: false` without an `@ts-ignore`.
 */
export declare function rewriteWorkerUrls(
  text: string,
  emitsSibling: (jsSpecifier: string) => boolean,
): { text: string; rewritten: string[]; left: string[] };
