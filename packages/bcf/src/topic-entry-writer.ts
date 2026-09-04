/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type JSZip from 'jszip';

/** The subset of JSZip a topic writer needs: add one file under the topic folder. */
export interface TopicEntryWriter {
  file(name: string, data: string | Uint8Array): void;
}

/**
 * Writes topic entries under a path prefix instead of through `zip.folder()`.
 * JSZip's `folder()` adds an explicit directory entry (`<guid>/`) to the
 * archive, and that entry was the one structural difference between an
 * export Solibri refused and the same topic re-exported by BIMcollab, which
 * Solibri opened (#3612). The BCF spec never asks for directory entries;
 * every file path already carries its folder.
 */
export function topicEntryWriter(zip: JSZip, folderName: string): TopicEntryWriter {
  return {
    file(name, data) {
      zip.file(`${folderName}/${name}`, data, { createFolders: false });
    },
  };
}
