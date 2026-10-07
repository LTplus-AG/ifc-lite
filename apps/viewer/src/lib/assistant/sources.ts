/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Enabled evidence adapters only (#6833). Each id has exactly one adapter in
 * `adapters/registry.ts`; adding a panel does not implicitly grant an AI
 * capability. Panels with no analysis result are listed as explicit
 * unsupported boundaries in the registry instead.
 */
export const ASSISTANT_SOURCES = [
  // Checks
  'clash', 'duplicates', 'validation', 'manualChecklist', 'lens', 'bcf',
  // Coordination
  'compare', 'changes', 'changeSets', 'zones', 'placement', 'schedule', 'semantic', 'layerDiff',
  // Quantities
  'lists', 'charts', 'cost', 'measurements', 'drawingMeasurements', 'deviation',
  // Model
  'loadReport', 'selection',
  // Automation
  'flow', 'flowRun', 'script', 'document',
] as const;
export type AssistantSource = typeof ASSISTANT_SOURCES[number];
export function isAssistantSource(value: unknown): value is AssistantSource {
  return typeof value === 'string' && ASSISTANT_SOURCES.some(source => source === value);
}

/**
 * Sources an AI report can be drafted from (#6918): every registered source
 * through one generic path, except Flow, whose evidence is a graph definition
 * rather than an analysis result (Flow conversations yield graph proposals).
 */
export function isReportSource(source: AssistantSource): boolean {
  return source !== 'flow';
}
