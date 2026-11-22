/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ScriptSlice } from './scriptSlice';

/**
 * Rollback restores the native revision, so a later edit can reuse a number a
 * client already holds. Adding the offset keeps agent revision tokens monotonic.
 */
export function scriptAdmissionRevision(state: Pick<ScriptSlice, 'scriptEditorRevision' | 'scriptEditorRevisionOffset'>): number {
  return state.scriptEditorRevision + state.scriptEditorRevisionOffset;
}
