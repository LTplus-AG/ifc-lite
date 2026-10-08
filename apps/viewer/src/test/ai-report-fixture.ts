/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic AI report discussions (#6918): a real native clash result in
 * the viewer store, its captured evidence, and a completed provider answer.
 * Clash `i` always carries key `a<i>`/`b<i>` and distance `distances[i]`, so
 * a test can reorder, change or drop rows and know exactly which native
 * finding a citation addresses.
 */

import { summarizeClashes, type Clash } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant } from '@/lib/assistant/conversation';

export function fixtureClash(index: number, distance: number): Clash {
  return { id: `c${index}`, a: { key: `a${index}`, ref: index + 1, model: 'a', tag: 'IfcWall' },
    b: { key: `b${index}`, ref: index + 501, model: 'a', tag: 'IfcPipeSegment' }, rule: 'coordination', status: 'hard',
    severity: 'major', distance, distanceKind: 'estimate', point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
}

/** Puts a native clash result in the store; `order` lists clash indices in native row order. */
export function seedClashResult(distances: readonly number[], order: readonly number[] = distances.map((_, index) => index)): void {
  const clashes = order.map(index => fixtureClash(index, distances[index]));
  const result = stampAnalysisReport({ clashes, summary: summarizeClashes(clashes), rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true } }, captureAnalysisStamp(true));
  useViewerStore.setState({ clashResult: result, clashRawResult: result });
}

/** A captured clash discussion whose last turn is `answer` from `actual-provider`. */
export function clashDiscussion(answer: string, distances: readonly number[] = [-0.02, -0.035, -0.05]): void {
  seedClashResult(distances);
  replaceEvidence(captureEvidence('clash'));
  useAssistant.setState({ messages: [{ role: 'user', content: 'Draft a report' }, { role: 'assistant', model: 'actual-provider', content: answer }] });
}

export interface FixtureClaim { text: string; citations?: string[]; facts?: Array<{ citation: string; field: string; value: string | number | boolean; unit?: string }> }

/** Prose followed by one fenced `report.claims` block, as the output guidance asks. */
export function typedReport(prose: string, claims: FixtureClaim[], language = 'en'): string {
  return `${prose}\n\n\`\`\`json\n${JSON.stringify({ version: 1, kind: 'report.claims', language, claims })}\n\`\`\`\n`;
}
