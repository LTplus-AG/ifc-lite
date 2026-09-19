/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Selector-reading feedback, shared by every surface that reads raw
 * IfcOpenShell selector text: the Filter tab's Selector field
 * (`SearchModal.filter.selector.tsx`) and a chart's source filter
 * (`ChartEditor.tsx`, #4946). Extracted rather than copied so the wording
 * and the error/warning styling cannot drift between the two — a defect the
 * search-tab-only fix for #4091 would otherwise reintroduce one field over.
 */
import type { SelectorParseError } from '@ifc-lite/query';

export interface SelectorFeedback {
  tone: 'error' | 'warning';
  lines: string[];
}

/** "…at character 7: …" plus the offending tail, so the caret is findable. */
export function describeSelectorParseError(query: string, error: SelectorParseError): string {
  const tail = query.slice(error.offset, error.offset + 24);
  const at = tail.length > 0 ? ` (at ${JSON.stringify(tail)})` : ' (at the end)';
  return `Character ${error.offset + 1}${at}: ${error.message}`;
}

export function SelectorFeedbackList({ feedback }: { feedback: SelectorFeedback }) {
  return (
    <ul
      role="alert"
      className={`flex flex-col gap-0.5 text-[11px] ${
        feedback.tone === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'
      }`}
    >
      {feedback.lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
