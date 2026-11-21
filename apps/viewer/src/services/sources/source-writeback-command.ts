/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export const SOURCE_WRITEBACK_EVENT = 'ifc-lite:save-to-source';
export function openSourceWriteBack(modelId: string): void {
  window.dispatchEvent(new CustomEvent<string>(SOURCE_WRITEBACK_EVENT, { detail: modelId }));
}


export const SOURCE_WRITEBACK_SAVED_EVENT = 'ifc-lite:source-file-saved';
export function notifySourceWriteBackSaved(providerId: string, projectId: string): void {
  window.dispatchEvent(new CustomEvent(SOURCE_WRITEBACK_SAVED_EVENT, { detail: { providerId, projectId } }));
}
