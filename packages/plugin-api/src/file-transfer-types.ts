/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SourceFileRef, SourceFile, SourceRevision } from './types.js';

/** Where `uploadFile` puts the bytes. `mode` is checked against `capabilities.writeBack`. */
export type UploadTarget =
  | {
      readonly mode: 'new-version';
      /** The file to add a revision to; `ref.revisionId` is ignored. */
      readonly ref: SourceFileRef;
      /**
       * The revision the bytes were derived from. When set and the file's
       * current revision differs, the provider returns a `stale-base`
       * conflict instead of silently making the user's edit the newest
       * revision over someone else's. Omit to skip the check.
       */
      readonly baseRevisionId?: string;
    }
  | {
      readonly mode: 'new-file' | 'new-location';
      readonly projectId: string;
      /** Destination container. */
      readonly containerId: string;
      /** Name of the file to create. */
      readonly fileName: string;
    };

export interface UploadOptions {
  readonly signal?: AbortSignal;
  /** Called with bytes sent and the total. */
  readonly onProgress?: (sent: number, total: number) => void;
  readonly mimeType?: string;
}

/**
 * Why an upload was refused without writing anything. A conflict is an
 * expected outcome, not an error: the host offers the user a way out (save as
 * a new file, or reload) instead of showing a failure.
 */
export type UploadConflict =
  | {
      readonly kind: 'stale-base';
      /** The file's current revision, which is not the one the edit was based on. */
      readonly currentRevisionId: string;
    }
  | {
      readonly kind: 'name-exists';
      /** The existing file that already has the requested name in that container. */
      readonly existingFileId: string;
    };

export type UploadResult =
  | { readonly ok: true; readonly file: SourceFile; readonly revision: SourceRevision }
  | { readonly ok: false; readonly conflict: UploadConflict };

export interface DownloadOptions {
  readonly signal?: AbortSignal;
  /** Called with bytes received and, when the provider knows it, the total. */
  readonly onProgress?: (received: number, total?: number) => void;
  /** Preparation/conversion has no fabricated byte percentage. */
  readonly onPhase?: (phase: 'preparing' | 'downloading') => void;
}

