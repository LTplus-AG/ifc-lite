/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Prefer the active (usually just-authored) model, with a stable first-model fallback. */
export function preferredExportModelId(modelIds: readonly string[], activeModelId: string | null): string {
  return activeModelId && modelIds.includes(activeModelId) ? activeModelId : modelIds[0] ?? '';
}
