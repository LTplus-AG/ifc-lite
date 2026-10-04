/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Enabled evidence adapters only. Adding a panel does not implicitly grant an AI capability. */
export const ASSISTANT_SOURCES = ['clash', 'validation', 'compare', 'flow', 'loadReport'] as const;
export type AssistantSource = typeof ASSISTANT_SOURCES[number];
export function isAssistantSource(value: unknown): value is AssistantSource {
  return typeof value === 'string' && ASSISTANT_SOURCES.some(source => source === value);
}
