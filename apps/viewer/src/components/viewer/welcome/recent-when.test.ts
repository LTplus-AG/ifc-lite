/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatBadge, recentWhen } from './recent-when.js';

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const MIN = 60_000;

describe('recentWhen', () => {
  it('says minutes, hours and days while it is recent', () => {
    assert.equal(recentWhen('en', NOW - 5 * MIN, NOW), '5 minutes ago');
    assert.equal(recentWhen('en', NOW - 3 * 60 * MIN, NOW), '3 hours ago');
    assert.equal(recentWhen('en', NOW - 24 * 60 * MIN, NOW), 'yesterday');
  });

  it('never says "in 0 minutes" for something opened just now', () => {
    assert.equal(recentWhen('en', NOW, NOW), '1 minute ago');
  });

  it('falls back to a short date after a week', () => {
    assert.match(recentWhen('en', NOW - 10 * 24 * 60 * MIN, NOW), /Oct/);
  });
});

describe('formatBadge', () => {
  it('upper-cases the extension and ignores dotfiles', () => {
    assert.equal(formatBadge('AC20-FZK-Haus.ifc'), 'IFC');
    assert.equal(formatBadge('scan.e57'), 'E57');
    assert.equal(formatBadge('.ifc'), '');
    assert.equal(formatBadge('README'), '');
  });
});
