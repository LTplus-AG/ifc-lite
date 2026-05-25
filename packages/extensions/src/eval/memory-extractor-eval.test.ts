/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Memory-extractor eval suite (P4 gate).
 *
 * The RFC §06.4 acceptance bar:
 *
 *   - **Precision ≥ 90%** — of the proposals the extractor emits,
 *     ≥ 90% should be stable preferences (not noise).
 *   - **Recall ≥ 50%** — of the labelled preferences in a transcript,
 *     the extractor should surface ≥ 50%.
 *   - **Privacy leak rate = 0%** — no proposal carries content from
 *     the blocklist (GUIDs, paths, emails, API keys, long IDs).
 *
 * v1 thresholds use a small labelled fixture set. The targets are
 * deliberately loose for v1 — the rule-based extractor is a stepping
 * stone toward the LLM-assisted version (Phase 4 stretch). Tightening
 * thresholds later only requires updating the constants below.
 */

import { describe, expect, it } from 'vitest';
import {
  extractMemoryProposals,
  type MemoryProposal,
  type TranscriptTurn,
} from '../flavor/memory-extractor.js';

interface LabelledFixture {
  name: string;
  transcript: TranscriptTurn[];
  /** Phrasings the extractor SHOULD surface (recall). */
  expectedPreferences: readonly RegExp[];
  /** Patterns that must NOT appear in any proposal (leak detection). */
  forbidden: readonly RegExp[];
}

const FIXTURES: LabelledFixture[] = [
  {
    name: 'csv-prefs',
    transcript: [
      { role: 'user', content: 'Always export CSV with semicolon separators.' },
      { role: 'assistant', content: 'Got it. Anything else?' },
      { role: 'user', content: 'Never include the GlobalId column.' },
    ],
    expectedPreferences: [/semicolon/i, /never.*GlobalId/i],
    forbidden: [],
  },
  {
    name: 'noise-mixed',
    transcript: [
      { role: 'user', content: 'The wall is always IFC' },
      { role: 'user', content: 'I will always check' },
      { role: 'user', content: 'Always color IfcDoor green.' },
    ],
    // Only the third should fire; the first two are modal-verb noise.
    expectedPreferences: [/color.*IfcDoor/i],
    forbidden: [],
  },
  {
    name: 'guid-leak',
    transcript: [
      { role: 'user', content: 'Always highlight 1A2B3C4D-5E6F-7890-ABCD-EF1234567890 in red.' },
    ],
    expectedPreferences: [],
    forbidden: [/[0-9A-F]{8}-[0-9A-F]{4}/i],
  },
  {
    name: 'path-leak',
    transcript: [
      { role: 'user', content: 'Always save exports to /tmp/exports/out.csv every Friday.' },
    ],
    expectedPreferences: [],
    forbidden: [/\/tmp\//],
  },
  {
    name: 'email-leak',
    transcript: [
      { role: 'user', content: 'Always send a notification to ops@example.com when exports finish.' },
    ],
    expectedPreferences: [],
    forbidden: [/\bops@/, /example\.com/],
  },
  {
    name: 'api-key-leak',
    transcript: [
      { role: 'user', content: 'Always use my key sk-ant-abc-def-token-xyz-1234 when calling.' },
    ],
    expectedPreferences: [],
    forbidden: [/sk-ant-/],
  },
  {
    name: 'preference-vocabulary',
    transcript: [
      { role: 'user', content: 'I prefer to render walls with thick outlines.' },
      { role: 'user', content: 'Do not auto-fly to selections.' },
      { role: 'user', content: 'My preference is metric units.' },
    ],
    expectedPreferences: [/thick outlines/i, /auto-fly/i, /metric units/i],
    forbidden: [],
  },
];

/** Targets — RFC §06.4 acceptance thresholds. */
const PRECISION_TARGET = 0.9;
const RECALL_TARGET = 0.5;
const PRIVACY_LEAK_RATE_TARGET = 0;

describe('eval: memory extractor', () => {
  it('records the threshold targets so the suite is self-documenting', () => {
    expect(PRECISION_TARGET).toBeGreaterThanOrEqual(0.9);
    expect(RECALL_TARGET).toBeGreaterThanOrEqual(0.5);
    expect(PRIVACY_LEAK_RATE_TARGET).toBe(0);
  });

  it('hits precision ≥ 0.9 across the labelled fixture set', () => {
    let truePositives = 0;
    let totalProposals = 0;
    for (const fx of FIXTURES) {
      const proposals = extractMemoryProposals(fx.transcript);
      totalProposals += proposals.length;
      for (const p of proposals) {
        // Count as TP if it matches a labelled expected preference.
        if (fx.expectedPreferences.some((rx) => rx.test(p.phrasing))) {
          truePositives += 1;
        }
      }
    }
    const precision = totalProposals === 0 ? 1 : truePositives / totalProposals;
    expect(precision).toBeGreaterThanOrEqual(PRECISION_TARGET);
  });

  it('hits recall ≥ 0.5 across the labelled fixture set', () => {
    let recovered = 0;
    let labelled = 0;
    for (const fx of FIXTURES) {
      labelled += fx.expectedPreferences.length;
      const proposals = extractMemoryProposals(fx.transcript);
      for (const expected of fx.expectedPreferences) {
        if (proposals.some((p) => expected.test(p.phrasing))) {
          recovered += 1;
        }
      }
    }
    const recall = labelled === 0 ? 1 : recovered / labelled;
    expect(recall).toBeGreaterThanOrEqual(RECALL_TARGET);
  });

  it('leak rate is exactly 0 — no proposal carries any forbidden content', () => {
    let leaks = 0;
    let totalProposals = 0;
    for (const fx of FIXTURES) {
      const proposals = extractMemoryProposals(fx.transcript);
      totalProposals += proposals.length;
      for (const p of proposals) {
        if (fx.forbidden.some((rx) => rx.test(p.phrasing))) {
          leaks += 1;
        }
      }
    }
    const leakRate = totalProposals === 0 ? 0 : leaks / totalProposals;
    expect(leakRate).toBe(PRIVACY_LEAK_RATE_TARGET);
  });

  it('per-fixture: every forbidden pattern is fully blocked', () => {
    for (const fx of FIXTURES) {
      const proposals = extractMemoryProposals(fx.transcript);
      for (const forbidden of fx.forbidden) {
        const leak = proposals.find((p: MemoryProposal) => forbidden.test(p.phrasing));
        if (leak) {
          throw new Error(
            `Fixture "${fx.name}" leaked forbidden pattern ${forbidden} via "${leak.phrasing}"`,
          );
        }
      }
    }
    // Sanity: the fixture set actually has proposals to vet.
    const total = FIXTURES.reduce(
      (n, fx) => n + extractMemoryProposals(fx.transcript).length,
      0,
    );
    expect(total).toBeGreaterThan(0);
  });
});
