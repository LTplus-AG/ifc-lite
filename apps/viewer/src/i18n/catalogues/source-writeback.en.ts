/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { registerEnglish } from '../registry';

export const sourceWriteBackEn = {
  'sources.writeBack.loadedModels': 'Save loaded IFC models',
  'sources.writeBack.open': 'Save to source',
  'sources.writeBack.openModel': 'Save {name} to source',
  'sources.writeBack.description': 'Send the current edited IFC model {name} to {provider}.',
  'sources.writeBack.mode': 'Save as',
  'sources.writeBack.newVersion': 'A new version of the original file',
  'sources.writeBack.newFile': 'A new file in the same folder',
  'sources.writeBack.newLocation': 'A new file in another folder',
  'sources.writeBack.name': 'IFC filename',
  'sources.writeBack.folder': 'Destination folder',
  'sources.writeBack.projectFolders': 'Project folders',
  'sources.writeBack.selectedFolder': 'Selected folder: {name}',
  'sources.writeBack.noFolder': 'Choose a folder',
  'sources.writeBack.up': 'Parent folder',
  'sources.writeBack.useFolder': 'Use this folder',
  'sources.writeBack.moreFolders': 'Load more folders',
  'sources.writeBack.base': 'Loaded revision: {revision}',
  'sources.writeBack.confirm': 'I confirm sending the current edits. A remote revision or file will be created, and this model will follow the saved file. Conflicts will not be overwritten automatically.',
  'sources.writeBack.save': 'Confirm and save',
  'sources.writeBack.saving': 'Saving…',
  'sources.writeBack.close': 'Close',
  'sources.writeBack.loading': 'Loading…',
  'sources.writeBack.saved': 'Saved to source. Your local edits have been kept.',
  'sources.writeBack.savedUnlinked': 'The file was saved, but the loaded model changed during the upload. Its source link was left unchanged. Do not repeat the upload to recover the link.',
  'sources.writeBack.history': 'Saved file revision history',
  'sources.writeBack.moreHistory': 'Load more revisions',
  'sources.writeBack.historyError': 'The upload succeeded, but revision history could not be loaded: {reason}',
  'sources.writeBack.modelChanged': 'The model or loaded source revision changed. Close and reopen Save to source before continuing.',
  'sources.writeBack.unavailable': 'This loaded model or source does not support IFC write-back.',
  'sources.writeBack.staleBase': 'The source has a newer revision. Nothing was uploaded. Save under a new name, or reload the source and reconcile your edits before trying a new version.',
  'sources.writeBack.nameExists': 'That name already exists in the chosen folder. Nothing was uploaded. Choose another name or folder.',
  'sources.writeBack.invalidDestination': 'Choose a destination folder and a valid filename ending in .ifc.',
  'sources.writeBack.failed': 'Save failed: {reason}. Check the source before retrying; a failed response does not always mean no file was created.',
} as const;

registerEnglish(sourceWriteBackEn);
