/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AuthoringPlan — structured representation of an AI-generated plan
 * BEFORE code is produced. The user reviews and edits this plan; only
 * after approval does the pipeline synthesise the actual bundle.
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §4.
 */

import type { ValidationError, ValidationResult } from '../types.js';

export interface AuthoringPlan {
  /** One-line summary shown in the chat surface. */
  summary: string;
  /** One paragraph of "why" — surfaced as detail below the summary. */
  rationale: string;
  /** Planned contributions (commands, panels, etc). */
  contributions: PlannedContribution[];
  /** Capabilities the plan will request. User can edit / prune. */
  capabilities: string[];
  /** Activation events the bundle will declare. */
  triggers: string[];
  /** Widgets the plan will ship. Empty for command-only extensions. */
  widgets: PlannedWidget[];
  /** Tests the plan will ship. At least one for any output-producing contribution. */
  tests: PlannedTest[];
  /** Optional open questions / assumptions to surface. */
  notes?: string;
}

export interface PlannedContribution {
  kind: 'command' | 'toolbar' | 'dock' | 'contextMenu' | 'keybinding' | 'lens' | 'exporter' | 'idsValidator' | 'statusBar';
  /** Display label for the plan card. */
  label: string;
  /** Stable id this contribution will receive in the manifest. */
  id?: string;
  /** Optional slot identifier (e.g. `toolbar.right`). */
  slot?: string;
  /** Optional `when` clause. */
  when?: string;
}

export interface PlannedWidget {
  /** Path the widget will be saved under (e.g. `widgets/report.json`). */
  path: string;
  /** Short description of the widget. */
  description: string;
}

export interface PlannedTest {
  /** Display name for the plan card. */
  name: string;
  /** Fixture id from `tests/models/manifest.json`. */
  fixture: string;
  /** What the test asserts (shape, byte count, regex, etc.). */
  assertionSummary: string;
}

const CONTRIBUTION_KINDS = new Set([
  'command', 'toolbar', 'dock', 'contextMenu', 'keybinding',
  'lens', 'exporter', 'idsValidator', 'statusBar',
]);

/** Validate a plan shape. Tolerant of optional fields. */
export function validatePlan(input: unknown): ValidationResult<AuthoringPlan> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '', code: 'type_mismatch', message: 'Plan must be an object.' }] };
  }
  const obj = input;
  requireString(errors, obj, 'summary');
  requireString(errors, obj, 'rationale');
  validateArray<PlannedContribution>(errors, obj.contributions, 'contributions', (item, p) => {
    if (!isPlainObject(item)) return;
    if (typeof item.kind !== 'string' || !CONTRIBUTION_KINDS.has(item.kind)) {
      errors.push({ path: `${p}.kind`, code: 'invalid_value', message: 'Unknown contribution kind.' });
    }
    if (typeof item.label !== 'string') {
      errors.push({ path: `${p}.label`, code: 'required', message: 'label is required.' });
    }
  });
  validateArray<string>(errors, obj.capabilities, 'capabilities', (item, p) => {
    if (typeof item !== 'string') {
      errors.push({ path: p, code: 'type_mismatch', message: 'Each capability must be a string.' });
    }
  });
  validateArray<string>(errors, obj.triggers, 'triggers', (item, p) => {
    if (typeof item !== 'string') {
      errors.push({ path: p, code: 'type_mismatch', message: 'Each trigger must be a string.' });
    }
  });
  validateArray<PlannedWidget>(errors, obj.widgets, 'widgets', (item, p) => {
    if (!isPlainObject(item)) return;
    if (typeof item.path !== 'string') {
      errors.push({ path: `${p}.path`, code: 'required', message: 'path is required.' });
    }
    if (typeof item.description !== 'string') {
      errors.push({ path: `${p}.description`, code: 'required', message: 'description is required.' });
    }
  });
  validateArray<PlannedTest>(errors, obj.tests, 'tests', (item, p) => {
    if (!isPlainObject(item)) return;
    for (const field of ['name', 'fixture', 'assertionSummary'] as const) {
      if (typeof item[field] !== 'string') {
        errors.push({ path: `${p}.${field}`, code: 'required', message: `${field} is required.` });
      }
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: obj as unknown as AuthoringPlan };
}

function requireString(errors: ValidationError[], obj: Record<string, unknown>, field: string): void {
  if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
    errors.push({ path: field, code: 'required', message: `${field} is required and must be a non-empty string.` });
  }
}

function validateArray<T>(
  errors: ValidationError[],
  raw: unknown,
  path: string,
  itemValidator: (item: unknown, path: string) => void,
): void {
  if (!Array.isArray(raw)) {
    errors.push({ path, code: 'required', message: `${path} must be an array.` });
    return;
  }
  raw.forEach((item, i) => itemValidator(item as T, `${path}[${i}]`));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
