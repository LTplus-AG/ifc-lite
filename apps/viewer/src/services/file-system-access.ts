/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * File System Access API helpers (Chromium: Chrome / Edge).
 *
 * Opening a file via `showOpenFilePicker` yields a live `FileSystemFileHandle`.
 * Unlike a `<input type="file">` File — a frozen snapshot of the bytes at pick
 * time — a handle can be re-read on demand with `getFile()`, which returns a
 * fresh File reflecting the current on-disk contents. That is what powers the
 * "Refresh" action: re-read the same file the user is editing in their
 * authoring tool, without re-picking it (issue #1345).
 *
 * Browsers without the API (Firefox / Safari) fall back to `<input type="file">`,
 * where no handle exists and Refresh is simply not offered.
 */

/** Accept filter mirroring the `<input type="file">` accept list. */
const IFC_ACCEPT_TYPES: FilePickerAcceptType[] = [
  {
    description: 'BIM models & point clouds',
    accept: {
      'application/octet-stream': [
        '.ifc',
        '.ifcx',
        '.glb',
        '.las',
        '.laz',
        '.ply',
        '.pcd',
        '.e57',
        '.pts',
        '.xyz',
        '.dxf',
      ],
    },
  },
];

export interface OpenedFile {
  file: File;
  handle: FileSystemFileHandle;
}

/**
 * Whether this browser exposes the File System Access open API. Requires a
 * secure context (https / localhost) and a Chromium engine.
 */
export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
}

/**
 * Prompt the user to pick one or more BIM files, returning both the File and
 * its live handle for each. Returns `null` when the user cancels, the API is
 * unavailable, or the picker fails — so callers can fall back to
 * `<input type="file">`.
 */
export async function openIfcFilesWithHandles(): Promise<OpenedFile[] | null> {
  if (!supportsFileSystemAccess()) return null;

  let handles: FileSystemFileHandle[];
  try {
    handles = await window.showOpenFilePicker!({
      multiple: true,
      excludeAcceptAllOption: false,
      types: IFC_ACCEPT_TYPES,
    });
  } catch (err) {
    // AbortError = the user dismissed the dialog; not worth surfacing.
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    console.warn('[file-system-access] showOpenFilePicker failed, falling back', err);
    return null;
  }

  const opened: OpenedFile[] = [];
  for (const handle of handles) {
    try {
      opened.push({ file: await handle.getFile(), handle });
    } catch (err) {
      console.warn(`[file-system-access] could not read "${handle.name}"`, err);
    }
  }
  return opened.length > 0 ? opened : null;
}

/**
 * Ensure we still hold read permission for a handle, prompting if the grant
 * lapsed. Resolves true when read access is granted. The request path must run
 * inside a user gesture. When the engine lacks the permission probes (some
 * Chromium builds expose `showOpenFilePicker` but not `queryPermission`), we
 * optimistically return true and let `getFile()` surface the real error.
 */
async function ensureReadPermission(handle: FileSystemFileHandle): Promise<boolean> {
  if (typeof handle.queryPermission !== 'function') return true;
  const opts: FileSystemHandlePermissionDescriptor = { mode: 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (typeof handle.requestPermission === 'function') {
    return (await handle.requestPermission(opts)) === 'granted';
  }
  return false;
}

/**
 * Re-read a handle's current on-disk contents. Returns a fresh File, or `null`
 * if permission was denied or the file is no longer reachable (moved/deleted).
 * Must be called from a user gesture so the permission prompt can show.
 */
export async function readFreshFile(handle: FileSystemFileHandle): Promise<File | null> {
  if (!(await ensureReadPermission(handle))) return null;
  try {
    return await handle.getFile();
  } catch (err) {
    console.warn(`[file-system-access] refresh read failed for "${handle.name}"`, err);
    return null;
  }
}

/**
 * Capture live handles for files dropped onto the page (Chromium). Returns one
 * `{ file, handle }` per dropped file that exposes a file handle, or `null` when
 * the API is unavailable so the caller can fall back to `dataTransfer.files`.
 *
 * MUST be invoked synchronously from the `drop` event handler: the
 * `DataTransferItemList` is neutered the moment the handler returns to the event
 * loop, so every `getAsFileSystemHandle()` call is kicked off before the first
 * `await` and only then resolved together.
 */
export function handlesFromDataTransfer(dataTransfer: DataTransfer): Promise<OpenedFile[] | null> {
  if (!supportsFileSystemAccess()) return Promise.resolve(null);
  const items = Array.from(dataTransfer.items).filter((i) => i.kind === 'file');
  if (items.length === 0) return Promise.resolve(null);
  if (typeof items[0].getAsFileSystemHandle !== 'function') return Promise.resolve(null);

  // Synchronous: start every handle request before awaiting anything.
  const pending = items.map((item) => {
    try {
      return item.getAsFileSystemHandle?.() ?? Promise.resolve(null);
    } catch (err) {
      console.warn('[file-system-access] getAsFileSystemHandle threw for a dropped item', err);
      return Promise.resolve(null);
    }
  });

  return (async () => {
    const handles = await Promise.all(pending);
    const opened: OpenedFile[] = [];
    for (const h of handles) {
      if (h && h.kind === 'file') {
        const fh = h as FileSystemFileHandle;
        try {
          opened.push({ file: await fh.getFile(), handle: fh });
        } catch (err) {
          console.warn(`[file-system-access] drag handle read failed for "${fh.name}"`, err);
        }
      }
    }
    return opened.length > 0 ? opened : null;
  })();
}
