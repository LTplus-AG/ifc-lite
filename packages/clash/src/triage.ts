/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AI-assisted clash triage: build a structured prompt from a clash result and
 * parse the LLM response into actionable recommendations. These are pure
 * functions — the host (desktop, web chat, CLI `ask`, MCP `clash_review`) owns
 * the actual LLM call.
 */

import type { ClashResult, ClashSeverity } from './types.js';

export interface ClashTriageResult {
  summary: string;
  recommendations: string[];
  severityCounts: Record<ClashSeverity, number>;
}

/** System prompt instructing the LLM to act as a BIM coordination specialist. */
export function buildTriageSystemPrompt(): string {
  return `You are a BIM coordination specialist analyzing clash detection results from an IFC model. Your job is to:

1. Summarize the clash results concisely (2-3 sentences).
2. Prioritize which clashes to resolve first based on:
   - Severity (critical > major > minor > info)
   - Impact on construction schedule and cost
   - Safety implications
3. Provide 3-5 actionable recommendations for resolving the most important clashes.
4. Suggest which discipline team should take ownership of each recommendation.

Respond in this exact JSON format:
{
  "summary": "Brief summary of clash results",
  "recommendations": [
    "Recommendation 1 — [DISCIPLINE] — description",
    "Recommendation 2 — [DISCIPLINE] — description"
  ]
}

Keep recommendations specific and actionable. Use discipline codes: ARCH, STR, MEP, HVAC, ELEC, FIRE.
Do not include any text outside the JSON.`;
}

function countSeverities(result: ClashResult): Record<ClashSeverity, number> {
  const counts: Record<ClashSeverity, number> = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const clash of result.clashes) {
    counts[clash.severity] += 1;
  }
  return counts;
}

/** Build the user message with structured clash data for the LLM. */
export function buildTriageUserMessage(result: ClashResult): string {
  const severityCounts = countSeverities(result);

  const lines: string[] = [
    `## Clash Detection Results`,
    ``,
    `**Total clashes:** ${result.summary.total}`,
    `**Tolerance:** ${result.settings.tolerance} m`,
    ``,
    `### Severity Breakdown`,
    `- Critical: ${severityCounts.critical}`,
    `- Major: ${severityCounts.major}`,
    `- Minor: ${severityCounts.minor}`,
    `- Info: ${severityCounts.info}`,
    ``,
    `### By Rule`,
  ];

  for (const [rule, count] of Object.entries(result.summary.byRule)) {
    lines.push(`- ${rule}: ${count} clashes`);
  }

  lines.push(``, `### By Type Pair`);
  const sortedPairs = Object.entries(result.summary.byTypePair).sort(([, a], [, b]) => b - a);
  for (const [pair, count] of sortedPairs.slice(0, 15)) {
    lines.push(`- ${pair}: ${count}`);
  }

  const important = result.clashes
    .filter((c) => c.severity === 'critical' || c.severity === 'major')
    .slice(0, 10);

  if (important.length > 0) {
    lines.push(``, `### Sample Critical/Major Clashes`);
    for (const c of important) {
      const aLabel = c.a.name || c.a.key.slice(0, 8);
      const bLabel = c.b.name || c.b.key.slice(0, 8);
      lines.push(
        `- [${c.severity}] ${c.a.tag} "${aLabel}" vs ${c.b.tag} "${bLabel}" — ${formatDistance(c.distance)} (rule: ${c.rule})`,
      );
    }
  }

  return lines.join('\n');
}

function formatDistance(distance: number): string {
  return distance < 0
    ? `penetration ${Math.abs(distance).toFixed(3)} m`
    : `gap ${distance.toFixed(3)} m`;
}

/** Parse the LLM's JSON response into a structured triage result. */
export function parseTriageResponse(text: string, result: ClashResult): ClashTriageResult {
  const severityCounts = countSeverities(result);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { summary: text.slice(0, 500), recommendations: [], severityCounts };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { summary?: string; recommendations?: string[] };
    return {
      summary: parsed.summary ?? 'Analysis complete.',
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
      severityCounts,
    };
  } catch (error) {
    // Malformed JSON from the model — fall back to the raw text as the summary.
    void error;
    return { summary: text.slice(0, 500), recommendations: [], severityCounts };
  }
}
