/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * OPFS-backed source buffer - stores the IFC source file in the Origin Private
 * File System instead of keeping the entire Uint8Array in the JS heap.
 *
 * For a 487MB IFC file, this moves ~487MB out of the JS heap into OPFS storage
 * that is backed by disk. Range reads are used for on-demand entity extraction.
 *
 * Falls back to in-memory Uint8Array when OPFS is not available (e.g., in
 * workers without navigator.storage, or non-secure contexts).
 */

// Minimal type declarations for OPFS APIs (File System Access API)
// These are not included in TypeScript's default lib.
interface OpfsSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

interface OpfsFileHandle {
  createSyncAccessHandle(): Promise<OpfsSyncAccessHandle>;
}

/**
 * A source buffer that can be backed by either in-memory Uint8Array or OPFS.
 * Provides sync and async read interfaces.
 *
 * Usage:
 * ```ts
 * const source = await OpfsSourceBuffer.create(uint8Buffer);
 * // On-demand entity extraction:
 * const bytes = await source.readRange(byteOffset, byteLength);
 * // Or use the sync subarray for backwards compatibility:
 * const view = source.subarray(byteOffset, byteOffset + byteLength);
 * ```
 *
 * @deprecated Experimental OPFS source storage is not wired into
 * `IfcDataStore.source`. Keep source bytes in the store until a future cache
 * format supports OPFS-backed range reads end-to-end.
 */
export class OpfsSourceBuffer {
  /** In-memory buffer (null when offloaded to OPFS) */
  private memoryBuffer: Uint8Array | null;
  /** OPFS sync access handle for range reads (null when in-memory) */
  private fileHandle: OpfsSyncAccessHandle | null = null;
  /** Async file handle wrapper */
  private asyncFileHandle: OpfsFileHandle | null = null;
  /** Total file size in bytes */
  readonly byteLength: number;
  /** Whether the source is backed by OPFS */
  readonly isOpfsBacked: boolean;
  /** OPFS file name (for cleanup) */
  private opfsFileName: string | null = null;

  private constructor(
    memoryBuffer: Uint8Array | null,
    byteLength: number,
    isOpfsBacked: boolean
  ) {
    this.memoryBuffer = memoryBuffer;
    this.byteLength = byteLength;
    this.isOpfsBacked = isOpfsBacked;
  }

  /**
   * Create an OpfsSourceBuffer, offloading to OPFS when available.
   *
   * @param buffer - The source IFC file bytes
   * @param forceMemory - If true, skip OPFS and keep in memory
   * @returns A new OpfsSourceBuffer instance
   */
  static async create(buffer: Uint8Array, forceMemory: boolean = false): Promise<OpfsSourceBuffer> {
    if (forceMemory || !OpfsSourceBuffer.isOpfsAvailable()) {
      return new OpfsSourceBuffer(buffer, buffer.byteLength, false);
    }

    let fileName: string | null = null;
    let syncHandle: OpfsSyncAccessHandle | null = null;

    try {
      fileName = `ifc-source-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(fileName, { create: true }) as unknown as OpfsFileHandle;

      // Write buffer to OPFS using sync access handle (fastest path)
      syncHandle = await fileHandle.createSyncAccessHandle();
      const bytesWritten = syncHandle.write(buffer, { at: 0 });
      if (bytesWritten !== buffer.byteLength) {
        syncHandle.close();
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(fileName);
        throw new Error(
          `OPFS short write: wrote ${bytesWritten}/${buffer.byteLength} bytes`
        );
      }
      syncHandle.flush();

      const instance = new OpfsSourceBuffer(null, buffer.byteLength, true);
      instance.fileHandle = syncHandle;
      instance.asyncFileHandle = fileHandle;
      instance.opfsFileName = fileName;

      return instance;
    } catch {
      // OPFS failed — clean up partial resources and fall back to in-memory
      if (syncHandle) {
        try { syncHandle.close(); } catch { /* ignore */ }
      }
      if (fileName) {
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(fileName);
        } catch { /* ignore */ }
      }
      return new OpfsSourceBuffer(buffer, buffer.byteLength, false);
    }
  }

  /**
   * Check if OPFS is available in the current context.
   */
  static isOpfsAvailable(): boolean {
    return (
      typeof globalThis !== 'undefined' &&
      typeof globalThis.navigator?.storage?.getDirectory === 'function'
    );
  }

  /**
   * Read a byte range from the source buffer.
   * Works for both in-memory and OPFS-backed buffers.
   */
  readRange(byteOffset: number, byteLength: number): Uint8Array {
    if (byteOffset < 0 || byteLength < 0 || byteOffset + byteLength > this.byteLength) {
      throw new RangeError(
        `OpfsSourceBuffer.readRange: offset=${byteOffset} length=${byteLength} exceeds buffer size=${this.byteLength}`
      );
    }

    if (this.memoryBuffer) {
      // In-memory: zero-copy subarray view
      return this.memoryBuffer.subarray(byteOffset, byteOffset + byteLength);
    }

    if (this.fileHandle) {
      // OPFS sync access: read into a new buffer
      const dest = new Uint8Array(byteLength);
      const bytesRead = this.fileHandle.read(dest, { at: byteOffset });
      if (bytesRead < byteLength) {
        throw new Error(
          `OpfsSourceBuffer.readRange: short read (${bytesRead}/${byteLength} bytes at offset ${byteOffset})`
        );
      }
      return dest;
    }

    throw new Error('OpfsSourceBuffer: no backing store available');
  }

  /**
   * Synchronous subarray — for backward compatibility with code that
   * expects `source.subarray(start, end)`.
   *
   * When OPFS-backed, this allocates a new Uint8Array and reads from disk.
   * When in-memory, this returns a zero-copy view.
   */
  subarray(start: number, end: number): Uint8Array {
    return this.readRange(start, end - start);
  }

  /**
   * Get the full in-memory buffer (only available when not OPFS-backed).
   * Used as a migration aid — callers should prefer readRange().
   *
   * @throws Error if the buffer has been offloaded to OPFS
   */
  getMemoryBuffer(): Uint8Array {
    if (this.memoryBuffer) return this.memoryBuffer;
    throw new Error(
      'OpfsSourceBuffer: source has been offloaded to OPFS. Use readRange() instead.'
    );
  }

  /**
   * Check if the in-memory buffer is still available.
   */
  hasMemoryBuffer(): boolean {
    return this.memoryBuffer !== null;
  }

  /**
   * Release OPFS resources and clean up the temporary file.
   * Call this when the model is unloaded.
   */
  async dispose(): Promise<void> {
    if (this.fileHandle) {
      this.fileHandle.close();
      this.fileHandle = null;
    }

    if (this.opfsFileName) {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(this.opfsFileName);
      } catch {
        // Ignore cleanup errors
      }
      this.opfsFileName = null;
    }

    this.asyncFileHandle = null;
    this.memoryBuffer = null;
  }
}
