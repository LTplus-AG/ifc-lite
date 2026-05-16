/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Diagnostic helpers for the AI authoring loop.
 *
 * Renders `ValidationError[]` arrays into prompt-friendly text and
 * (for the chat UI) compact diagnostic chips. The repair loop feeds
 * structured diagnostics back to the model; this is the formatter.
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §8.
 */

import type { ValidationError } from '../types.js';

export interface DiagnosticGroup {
  /** Root category of the error path (e.g. "manifest", "src/commands/foo.js"). */
  scope: string;
  /** Errors in this scope. */
  errors: ValidationError[];
}

/** Group diagnostics by the leading path segment, for UI display. */
export function groupDiagnostics(errors: readonly ValidationError[]): DiagnosticGroup[] {
  const map = new Map<string, ValidationError[]>();
  for (const err of errors) {
    const scope = leadingScope(err.path);
    let list = map.get(scope);
    if (!list) {
      list = [];
      map.set(scope, list);
    }
    list.push(err);
  }
  return Array.from(map.entries()).map(([scope, list]) => ({ scope, errors: list }));
}

/** Pretty-print diagnostics for the chat UI (markdown-ish). */
export function renderDiagnostics(errors: readonly ValidationError[]): string {
  if (errors.length === 0) return '*No diagnostics.*';
  const groups = groupDiagnostics(errors);
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`**${group.scope}**`);
    for (const err of group.errors) {
      const path = err.path || '<root>';
      lines.push(`- \`${path}\` — ${err.message}`);
      if (err.hint) lines.push(`  - hint: ${err.hint}`);
    }
  }
  return lines.join('\n');
}

/** Compact one-line summary for chat headers / toasts. */
export function summariseDiagnostics(errors: readonly ValidationError[]): string {
  if (errors.length === 0) return 'No issues.';
  if (errors.length === 1) return `1 issue: ${errors[0].message}`;
  const groups = groupDiagnostics(errors);
  if (groups.length === 1) return `${errors.length} issues in ${groups[0].scope}.`;
  return `${errors.length} issues across ${groups.length} scopes.`;
}

function leadingScope(path: string): string {
  if (!path) return '<root>';
  const beforeIndex = path.split('[')[0];
  // File paths (with `/`) keep their extension — splitting on `.`
  // would mangle `src/foo.js` into `src/foo`. JSON paths split on `.`
  // to group by top-level key.
  if (beforeIndex.includes('/')) return beforeIndex;
  return beforeIndex.split('.')[0] || '<root>';
}

