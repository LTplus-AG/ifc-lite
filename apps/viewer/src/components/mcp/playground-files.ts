/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * playground-files.ts — virtual file store for the playground.
 *
 * Tools that "write a file" (bcf_export, model_save, export_ifc / csv /
 * json) DON'T trigger a browser download — that would be a surprising
 * privacy issue and against the user's explicit "never auto-download"
 * rule. Instead they push the artifact into this store, which a
 * Downloads panel in the playground sidebar lists with a per-row
 * "Download" button. The actual `Blob` → `<a download>` click only
 * happens when the user presses that button.
 */
import { useEffect, useState } from 'react';
import { downloadBlob } from '../../lib/export/download';

export interface PlaygroundFile {
  /** Stable id used by tools to refer back to a written artifact. */
  id: string;
  /** Suggested filename used when the user clicks Download. */
  filename: string;
  /** MIME type for the download Blob. */
  mimeType: string;
  /** Bytes — read once, cheap. */
  size: number;
  /** The data. */
  blob: Blob;
  /** ms since epoch. */
  createdAt: number;
  /** Tool that produced it (`bcf_export`, `model_save`, …). */
  source: string;
  /** Free-form line shown under the filename in the UI. */
  description?: string;
}

/** Keep at most this many staged artifacts; oldest are evicted on add(). */
const MAX_FILES = 20;
/** Drop oldest entries once the retained Blobs exceed this cumulative size. */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

class FileStore {
  private files: PlaygroundFile[] = [];
  private listeners = new Set<() => void>();
  private nextId = 1;
  /** Id of an entry exempt from eviction (e.g. the auto-staged BCF bundle). */
  private pinnedId: string | null = null;

  add(input: Omit<PlaygroundFile, 'id' | 'createdAt'>): PlaygroundFile {
    const file: PlaygroundFile = {
      ...input,
      id: `pg-file-${this.nextId++}`,
      createdAt: Date.now(),
    };
    this.files = this.evict([file, ...this.files]);
    this.notify();
    return file;
  }

  /** Mark an entry as exempt from eviction; pass null to clear the pin. */
  pin(id: string | null): void {
    this.pinnedId = id;
  }

  /**
   * Bound the store by count and cumulative bytes, evicting oldest-first
   * (entries are newest-first, so trim from the tail). The pinned entry is
   * never evicted so its tracked id can't be orphaned.
   */
  private evict(files: PlaygroundFile[]): PlaygroundFile[] {
    const kept: PlaygroundFile[] = [];
    let bytes = 0;
    for (const f of files) {
      const pinned = f.id === this.pinnedId;
      if (!pinned && kept.length >= MAX_FILES) continue;
      if (!pinned && bytes + f.size > MAX_TOTAL_BYTES && kept.length > 0) continue;
      kept.push(f);
      bytes += f.size;
    }
    return kept;
  }

  list(): PlaygroundFile[] {
    return this.files;
  }

  remove(id: string): void {
    this.files = this.files.filter((f) => f.id !== id);
    if (this.pinnedId === id) this.pinnedId = null;
    this.notify();
  }

  clear(): void {
    this.files = [];
    this.pinnedId = null;
    this.notify();
  }

  /** User-triggered. Synthesises an <a download> click — never called by
   *  tool code, only by the explicit Download button. */
  download(id: string): void {
    const file = this.files.find((f) => f.id === id);
    if (!file) return;
    // file.filename is already coerced (extension-forced, OS-safe) at creation.
    downloadBlob(file.blob, file.filename);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

export const playgroundFiles = new FileStore();

/** React hook for components that want to render the file list reactively. */
export function usePlaygroundFiles(): PlaygroundFile[] {
  const [files, setFiles] = useState<PlaygroundFile[]>(() => playgroundFiles.list());
  useEffect(() => playgroundFiles.subscribe(() => setFiles(playgroundFiles.list())), []);
  return files;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}
