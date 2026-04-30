/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface NativeFileHandle {
  path: string;
  name: string;
  size: number;
  modifiedMs?: number | null;
}

export interface GenericFileDialogOptions {
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

async function loadInvokeFromTauriModule(): Promise<InvokeFn | null> {
  try {
    const core = await import('@tauri-apps/api/core');
    return typeof core.invoke === 'function' ? core.invoke as InvokeFn : null;
  } catch {
    return null;
  }
}

async function loadDialogModule(): Promise<{
  open: (options?: {
    multiple?: boolean;
    directory?: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
    title?: string;
  }) => Promise<string | string[] | null>;
} | null> {
  try {
    return await import('@tauri-apps/plugin-dialog');
  } catch {
    return null;
  }
}

async function loadFsModule(): Promise<{
  stat: (path: string) => Promise<{ size: number }>;
} | null> {
  try {
    return await import('@tauri-apps/plugin-fs');
  } catch {
    return null;
  }
}

async function getInvoke(): Promise<InvokeFn> {
  const win = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: InvokeFn } };
  if (win.__TAURI_INTERNALS__?.invoke) {
    return win.__TAURI_INTERNALS__.invoke;
  }
  const moduleInvoke = await loadInvokeFromTauriModule();
  if (moduleInvoke) {
    return moduleInvoke;
  }
  throw new Error('Tauri API not available');
}

export async function openIfcFileDialog(): Promise<NativeFileHandle | null> {
  try {
    const invoke = await getInvoke();
    return await invoke<NativeFileHandle | null>('open_ifc_file');
  } catch {
    // Expected in browser builds — fall through to plugin fallback, then browser file input.
  }

  try {
    const dialog = await loadDialogModule();
    const fs = await loadFsModule();
    if (!dialog || !fs) {
      return null;
    }

    const selected = await dialog.open({
      multiple: false,
      directory: false,
      title: 'Open IFC or Point Cloud File',
      filters: [
        { name: 'IFC Files', extensions: ['ifc', 'ifczip', 'ifcxml', 'ifcx', 'glb'] },
        { name: 'Point Clouds', extensions: ['las', 'laz'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (!selected || Array.isArray(selected)) {
      return null;
    }

    const metadata = await fs.stat(selected);
    const normalizedPath = selected.toString();
    const pathSegments = normalizedPath.split(/[\\/]/);
    const name = pathSegments[pathSegments.length - 1] || 'unknown.ifc';

    return {
      path: normalizedPath,
      name,
      size: metadata.size,
    };
  } catch {
    // No Tauri plugin available — caller falls back to browser <input type="file">.
    return null;
  }
}

export async function readNativeFile(path: string): Promise<Uint8Array> {
  try {
    const invoke = await getInvoke();
    const bytes = await invoke<number[]>('read_native_file', { path });
    return Uint8Array.from(bytes);
  } catch (error) {
    console.warn('[FileDialog] Falling back to plugin-fs read for native file:', error);
    const fs = await import('@tauri-apps/plugin-fs');
    return fs.readFile(path);
  }
}

export async function openGenericFileDialog(options: GenericFileDialogOptions = {}): Promise<File | null> {
  try {
    const dialog = await loadDialogModule();
    if (!dialog) {
      return null;
    }

    const selected = await dialog.open({
      multiple: false,
      directory: false,
      title: options.title,
      filters: options.filters,
    });
    if (!selected || Array.isArray(selected)) {
      return null;
    }

    const normalizedPath = selected.toString();
    const bytes = await readNativeFile(normalizedPath);
    const pathSegments = normalizedPath.split(/[\\/]/);
    const name = pathSegments[pathSegments.length - 1] || 'document';
    // Slice to a fresh ArrayBuffer view — TS5+ narrows `Uint8Array` to
    // `Uint8Array<ArrayBufferLike>` which `BlobPart` doesn't accept.
    const blobPart = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
    return new File([blobPart], name, { type: 'application/octet-stream' });
  } catch (error) {
    console.warn('[FileDialog] Failed to open generic native file dialog:', error);
    return null;
  }
}
