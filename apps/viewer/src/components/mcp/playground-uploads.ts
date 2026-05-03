/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * playground-uploads.ts — virtual file system for INPUTS the user attaches
 * to a chat turn (IDS specs, side IFC files for diff, BCF imports later).
 *
 * Mirrors the playground-files.ts shape but for the other direction: the
 * user drops a `.ids` (or any text file) onto the chat textarea, we cache
 * it here, and tools that take a `*_path` argument (ids_validate,
 * ids_explain) resolve the path through this store BEFORE asking the agent
 * to inline the XML. That lifts the "the playground can't read disk" wart
 * and makes the chat experience continuous.
 */

import { useEffect, useState } from 'react';

export interface UploadedFile {
  /** The original filename, used as the lookup key (paths are normalised
   *  to the basename so the agent can pass `./foo.ids` or just `foo.ids`). */
  name: string;
  /** MIME type as the browser saw it. May be empty for `.ids`. */
  mimeType: string;
  /** Bytes — for sizing the chip and bounding what we accept. */
  size: number;
  /** Text content if the file is text/* — this is the path we use for
   *  ids_validate. Binaries store an empty string here and put bytes in
   *  `bytes` (future use; v1 only handles text). */
  text: string;
  /** Wall-clock when the user attached it. */
  uploadedAt: number;
}

class UploadStore {
  private uploads: UploadedFile[] = [];
  private listeners = new Set<() => void>();

  /** Read the file as text and stash it. Returns the entry.
   *
   *  We only decode known-text formats — `.bcfzip` and other binaries
   *  are zip archives whose .text() decode would chew through tens of
   *  megabytes on the main thread for no user benefit (the playground
   *  has no read path for binary attachments yet). */
  async add(file: File): Promise<UploadedFile> {
    const name = file.name.split(/[\\/]/).pop() ?? file.name;
    const mimeType = file.type || guessMimeType(name);
    const text = isTextLike(name, mimeType) ? await file.text() : '';
    const entry: UploadedFile = {
      name,
      mimeType,
      size: file.size,
      text,
      uploadedAt: Date.now(),
    };
    // De-dup by basename — re-attaching with the same name overwrites.
    this.uploads = [entry, ...this.uploads.filter((u) => u.name !== name)];
    this.notify();
    return entry;
  }

  /** Resolve a path-ish string to an upload. Tolerates absolute paths,
   *  ./relative, and bare filenames. */
  resolve(pathOrName: string): UploadedFile | null {
    if (!pathOrName) return null;
    const base = pathOrName.split(/[\\/]/).pop() ?? pathOrName;
    return this.uploads.find((u) => u.name === base) ?? null;
  }

  list(): UploadedFile[] {
    return this.uploads;
  }

  remove(name: string): void {
    this.uploads = this.uploads.filter((u) => u.name !== name);
    this.notify();
  }

  clear(): void {
    this.uploads = [];
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

export const playgroundUploads = new UploadStore();

export function usePlaygroundUploads(): UploadedFile[] {
  const [uploads, setUploads] = useState<UploadedFile[]>(() => playgroundUploads.list());
  useEffect(() => playgroundUploads.subscribe(() => setUploads(playgroundUploads.list())), []);
  return uploads;
}

/** Whether we should decode this attachment as text. STEP files (.ifc) and
 *  IDS specs are text under the hood; .bcfzip / arbitrary octet-stream
 *  attachments are zip archives we only ever surface as references. */
function isTextLike(name: string, mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (mimeType === 'application/json' || mimeType === 'application/xml' || mimeType === 'application/xhtml+xml') return true;
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'ifc' || ext === 'ids' || ext === 'csv' || ext === 'tsv' || ext === 'xml' || ext === 'json' || ext === 'txt' || ext === 'md';
}

function guessMimeType(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'ids': return 'application/xml';
    case 'xml': return 'application/xml';
    case 'json': return 'application/json';
    case 'csv': return 'text/csv';
    case 'txt': return 'text/plain';
    default: return 'application/octet-stream';
  }
}
