/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Analyze ribbon tab's "Validate" group has its own toggle button for
 * the BCF panel that once read "BCF issues". Topic is the BCF-XML container
 * element; Issue is only one TopicType value among several (Request, Comment,
 * Error, Warning, Info),
 * so "issues" narrowed and contradicted the spec (#4096/#4097). Pin the
 * corrected label here too, so it can't regress silently.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { resolveEnglish } from '@/i18n/registry';
import { panelTitleKey, type WorkspacePanelId } from '@/lib/panels/registry';
import { AnalyzeTab } from './AnalyzeTab.js';

describe('AnalyzeTab — BCF ribbon button', () => {
  afterEach(() => {
    cleanup();
  });

  it('labels the Validate-group BCF button "BCF Topics", not "BCF issues"', () => {
    const container = render(<AnalyzeTab />);
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
    assert.ok(
      labels.some((t) => /BCF Topics/.test(t)),
      `expected a button labelled "BCF Topics"; got: ${JSON.stringify(labels)}`,
    );
    assert.ok(
      !labels.some((t) => /BCF issues/i.test(t)),
      `found a button still labelled "BCF issues": ${JSON.stringify(labels)}`,
    );
  });
});

describe('AnalyzeTab — canonical panel groups (#5873)', () => {
  afterEach(cleanup);

  it('places direct panel shortcuts under the same task labels as the rail', () => {
    const container = render(<AnalyzeTab />);
    const groups = [...container.querySelectorAll<HTMLElement>('[role="group"]')];
    const expected: Array<[WorkspacePanelId, string]> = [
      ['zones', 'Coordinate'],
      ['lens', 'Check'],
      ['cost', 'Quantify'],
      ['script', 'Automate'],
      ['drawing', 'Site'],
    ];
    for (const [panelId, groupName] of expected) {
      const group = groups.find((node) => node.getAttribute('aria-label') === groupName);
      assert.ok(group, `${groupName} group is missing`);
      const title = resolveEnglish(panelTitleKey(panelId));
      assert.ok([...group.querySelectorAll('button')].some((button) => button.getAttribute('aria-label') === title),
        `${title} is outside ${groupName}`);
    }
  });
});
