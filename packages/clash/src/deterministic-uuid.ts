/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-export of the deterministic UUID generator, which now lives in
 * `@ifc-lite/encoding` beside `generateUuid`.
 *
 * It moved because `@ifc-lite/bcf` needs it too, to derive the
 * `DocumentReference/@Guid` that BCF 3.0 requires (#3612), and
 * `@ifc-lite/clash` DEPENDS ON `@ifc-lite/bcf` -- so importing it from here
 * would have been a package cycle, and copying the algorithm would have left
 * two implementations of one identity scheme held together by nothing but a
 * comment. Both packages already depend on `@ifc-lite/encoding`.
 *
 * This file stays so clash's own callers and its `deterministic-uuid.test.ts`
 * keep their import path, and so the guid a clash re-run produces cannot
 * change: the test pins exact output for fixed seeds, and it now pins the
 * shared implementation through this path.
 */

export { uuidFromSeed } from '@ifc-lite/encoding';
