/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  extractMemoryProposals,
  mergeIntoOverlay,
} from './memory-extractor.js';

describe('extractMemoryProposals', () => {
  it('picks up explicit "always" preferences', () => {
    const proposals = extractMemoryProposals([
      { role: 'user', content: 'Always use semicolon separators in CSV exports.' },
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].phrasing).toMatch(/Always.*semicolon/i);
  });

  it('picks up "never" preferences', () => {
    const proposals = extractMemoryProposals([
      { role: 'user', content: 'Never include the GlobalId column in exports.' },
    ]);
    // GlobalId in source — but the proposal phrasing is rejected only
    // if it matches the GUID blocklist regex. "GlobalId" alone is fine.
    expect(proposals.find((p) => p.phrasing.includes('Never'))).toBeTruthy();
  });

  it('drops proposals that contain a GUID', () => {
    const proposals = extractMemoryProposals([
      { role: 'user', content: 'Always highlight 7e8f9a01-2b3c-4d5e-6f7a-8b9c0d1e2f3a in red.' },
    ]);
    expect(proposals).toHaveLength(0);
  });

  it('drops proposals that contain a file path', () => {
    const proposals = extractMemoryProposals([
      { role: 'user', content: 'Always export to /tmp/exports/out.csv every Friday.' },
    ]);
    expect(proposals).toHaveLength(0);
  });

  it('drops proposals that contain an API key', () => {
    const proposals = extractMemoryProposals([
      { role: 'user', content: 'Always use my key sk-ant-abc123def456-token-789-xyz when calling.' },
    ]);
    expect(proposals).toHaveLength(0);
  });

  it('skips assistant turns', () => {
    const proposals = extractMemoryProposals([
      { role: 'assistant', content: 'Always check the manifest first.' },
    ]);
    expect(proposals).toHaveLength(0);
  });

  it('deduplicates equivalent phrasings', () => {
    const proposals = extractMemoryProposals([
      { role: 'user', content: 'Always use Pset_WallCommon for fire ratings.' },
      { role: 'user', content: 'Always use Pset_WallCommon for fire ratings.' },
    ]);
    expect(proposals).toHaveLength(1);
  });

  it('caps proposals at maxProposals', () => {
    const proposals = extractMemoryProposals(
      Array.from({ length: 20 }, (_, i) => ({
        role: 'user' as const,
        content: `Always use rule number ${i % 3} for the wall.`,
      })),
      { maxProposals: 2 },
    );
    expect(proposals.length).toBeLessThanOrEqual(2);
  });

  it('honours an extra blocklist', () => {
    const proposals = extractMemoryProposals(
      [{ role: 'user', content: 'Always use ACME Internal Format for exports.' }],
      { extraBlocklist: [/ACME Internal/] },
    );
    expect(proposals).toHaveLength(0);
  });
});

describe('mergeIntoOverlay', () => {
  it('seeds a Preferences section into an empty overlay', () => {
    const result = mergeIntoOverlay('', [
      { phrasing: 'Always do X.', sourceTurns: [0], confidence: 0.8 },
    ]);
    expect(result).toMatch(/## Preferences/);
    expect(result).toMatch(/- Always do X\./);
  });

  it('appends under the existing Preferences section', () => {
    const existing = '## Preferences\n\n- Always do X.\n';
    const result = mergeIntoOverlay(existing, [
      { phrasing: 'Never do Y.', sourceTurns: [0], confidence: 0.7 },
    ]);
    expect(result).toMatch(/Always do X/);
    expect(result).toMatch(/Never do Y/);
  });

  it('does not duplicate existing entries', () => {
    const existing = '## Preferences\n\n- Always do X.\n';
    const result = mergeIntoOverlay(existing, [
      { phrasing: 'Always do X.', sourceTurns: [0], confidence: 0.7 },
    ]);
    expect(result.match(/Always do X/g)).toHaveLength(1);
  });

  it('appends a fresh section when no Preferences exists yet', () => {
    const existing = 'Some pre-existing notes.';
    const result = mergeIntoOverlay(existing, [
      { phrasing: 'Always do X.', sourceTurns: [0], confidence: 0.7 },
    ]);
    expect(result).toMatch(/Some pre-existing notes/);
    expect(result).toMatch(/## Preferences/);
  });
});
