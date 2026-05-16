/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { buildAuthoringContract } from './prompt.js';

describe('buildAuthoringContract', () => {
  it('is deterministic — same string across calls', () => {
    expect(buildAuthoringContract()).toBe(buildAuthoringContract());
  });

  it('mentions the manifest schema', () => {
    expect(buildAuthoringContract()).toContain('ExtensionManifest');
  });

  it('mentions the widget DSL', () => {
    const text = buildAuthoringContract();
    expect(text).toContain('Stack');
    expect(text).toContain('Button');
    expect(text).toContain('KeyValueGrid');
  });

  it('lists capabilities with risk tiers', () => {
    const text = buildAuthoringContract();
    expect(text).toContain('model.read');
    expect(text).toContain('network.fetch');
    expect(text).toMatch(/red|green|yellow/);
  });

  it('forbids capability wildcards', () => {
    expect(buildAuthoringContract()).toContain('network.fetch:*');
  });

  it('mentions the test convention', () => {
    expect(buildAuthoringContract()).toContain('expect');
    expect(buildAuthoringContract()).toContain('fixture');
  });
});
