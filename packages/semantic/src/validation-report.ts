/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DEFAULT_PROFILE, type ProfileDefinition } from './profiles.js';
import { LIMITS } from './types.js';
import type { ValidationFinding } from './profile-types.js';

export interface ValidationReport {
  schemaVersion: 1;
  profile: { id: string; version: string };
  scope: 'profile' | 'graph';
  completeness: 'complete' | 'partial';
  source?: string;
  engines: ValidationFinding['engine'][];
  limits: { bytes: number; quads: number; findings: number };
  conforms: boolean;
  truncated: boolean;
  counts: Record<'Violation' | 'Warning' | 'Info', number>;
  findings: (ValidationFinding & { severity: NonNullable<ValidationFinding['severity']> })[];
}
/** Stable report envelope across workers, browser and headless clients. */
export function createValidationReport(input: {
  profile?: ProfileDefinition; scope: ValidationReport['scope']; completeness: ValidationReport['completeness'];
  source?: string; findings: readonly ValidationFinding[]; engines?: ValidationFinding['engine'][];
  limits?: Partial<ValidationReport['limits']>;
}): ValidationReport {
  const profile = input.profile ?? DEFAULT_PROFILE;
  const limits = { bytes: input.limits?.bytes ?? LIMITS.bytes, quads: input.limits?.quads ?? LIMITS.quads, findings: input.limits?.findings ?? LIMITS.findings };
  if (Object.values(limits).some(value => !Number.isInteger(value) || value < 1) || limits.bytes > LIMITS.bytes || limits.quads > LIMITS.quads || limits.findings > LIMITS.findings) throw new Error('Invalid validation report limits');
  const counts = { Violation: 0, Warning: 0, Info: 0 };
  for (const finding of input.findings) counts[finding.severity ?? 'Violation']++;
  return { schemaVersion: 1, profile: { id: profile.id, version: profile.version }, scope: input.scope, completeness: input.completeness,
    ...(input.source ? { source: input.source } : {}), engines: input.engines ?? [...new Set(input.findings.map(finding => finding.engine))], limits,
    conforms: counts.Violation === 0 && input.findings.length < limits.findings, truncated: input.findings.length >= limits.findings,
    counts, findings: input.findings.slice(0, limits.findings).map(finding => ({ ...finding, severity: finding.severity ?? 'Violation' })) };
}
