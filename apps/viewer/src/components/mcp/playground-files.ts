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

class FileStore {
  private files: PlaygroundFile[] = [];
  private listeners = new Set<() => void>();
  private nextId = 1;

  add(input: Omit<PlaygroundFile, 'id' | 'createdAt'>): PlaygroundFile {
    const file: PlaygroundFile = {
      ...input,
      id: `pg-file-${this.nextId++}`,
      createdAt: Date.now(),
    };
    this.files = [file, ...this.files];
    this.notify();
    return file;
  }

  list(): PlaygroundFile[] {
    return this.files;
  }

  remove(id: string): void {
    this.files = this.files.filter((f) => f.id !== id);
    this.notify();
  }

  clear(): void {
    this.files = [];
    this.notify();
  }

  /** User-triggered. Synthesises an <a download> click — never called by
   *  tool code, only by the explicit Download button. */
  download(id: string): void {
    const file = this.files.find((f) => f.id === id);
    if (!file) return;
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after a tick so the browser actually fetched the blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
