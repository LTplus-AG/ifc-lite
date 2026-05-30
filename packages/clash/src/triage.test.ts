/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTriageResponse } from './triage.js';
import type { ClashResult } from './types.js';

function makeResult(): ClashResult {
  return {
    clashes: [
      {
        id: 'c1',
        a: { key: 'a', ref: 1, model: 'm', tag: 'IfcPipeSegment' },
        b: { key: 'b', ref: 2, model: 'm', tag: 'IfcBeam' },
        rule: 'r1',
        status: 'hard',
        distance: -0.01,
        point: [0, 0, 0],
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        severity: 'critical',
      },
      {
        id: 'c2',
        a: { key: 'c', ref: 3, model: 'm', tag: 'IfcDuctSegment' },
        b: { key: 'd', ref: 4, model: 'm', tag: 'IfcWall' },
        rule: 'r1',
        status: 'hard',
        distance: -0.005,
        point: [0, 0, 0],
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        severity: 'minor',
      },
    ],
    summary: {
      total: 2,
      byRule: { r1: 2 },
      byTypePair: { 'IfcPipeSegment|IfcBeam': 1, 'IfcDuctSegment|IfcWall': 1 },
      bySeverity: { critical: 1, major: 0, minor: 1, info: 0 },
    },
    rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

describe('parseTriageResponse', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a well-formed JSON response into summary + recommendations', () => {
    const result = makeResult();
    const text = `Sure, here is the analysis:
{
  "summary": "Two clashes detected, one critical.",
  "recommendations": [
    "Reroute pipe — [MEP] — avoid the beam at gridline 3",
    "Coordinate duct path — [HVAC] — clear the wall penetration"
  ]
}
Let me know if you need more.`;

    const triage = parseTriageResponse(text, result);

    expect(triage.summary).toBe('Two clashes detected, one critical.');
    expect(triage.recommendations).toEqual([
      'Reroute pipe — [MEP] — avoid the beam at gridline 3',
      'Coordinate duct path — [HVAC] — clear the wall penetration',
    ]);
    expect(triage.severityCounts).toEqual({ critical: 1, major: 0, minor: 1, info: 0 });
  });

  it('falls back to the text slice and warns when the JSON is malformed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = makeResult();
    // Looks like JSON (passes the brace match) but is not valid JSON.
    const text = 'Analysis: {summary: not valid json, recommendations: [oops}';

    const triage = parseTriageResponse(text, result);

    expect(triage.summary).toBe(text.slice(0, 500));
    expect(triage.recommendations).toEqual([]);
    expect(triage.severityCounts).toEqual({ critical: 1, major: 0, minor: 1, info: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[clash/triage] failed to parse LLM JSON response; using raw text fallback',
      expect.any(Error),
    );
  });

  it('falls back to the text slice when there is no JSON object at all', () => {
    const result = makeResult();
    const text = 'No braces here, just prose about clashes.';

    const triage = parseTriageResponse(text, result);

    expect(triage.summary).toBe(text.slice(0, 500));
    expect(triage.recommendations).toEqual([]);
  });
});
