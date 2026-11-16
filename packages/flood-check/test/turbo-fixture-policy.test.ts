/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

describe('CI fixture policy', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true' && process.env.IFC_LITE_REQUIRE_FIXTURES !== '1')('reaches flood-check tests through Turbo', () => {
    expect(process.env.IFC_LITE_REQUIRE_FIXTURES).toBe('1');
  });
});
