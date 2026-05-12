/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal ambient type declarations for parquet-wasm and apache-arrow.
 *
 * These cover only the API surface actually used in this package,
 * avoiding the need for @ts-ignore on every call site.
 */

// ── parquet-wasm ──

declare module 'parquet-wasm/esm/arrow2.js' {
  /** Initialize WASM module. Pass a URL or Response to load from. */
  export default function init(wasmUrlOrResponse?: string | Response): Promise<void>;
  /** Read a Parquet buffer and return an Arrow IPC-compatible table. */
  export function readParquet(data: Uint8Array): ParquetTable;
}

declare module 'parquet-wasm/esm/arrow2_bg.wasm?url' {
  const url: string;
  export default url;
}

interface ParquetTable {
  /** Convert to Arrow IPC stream bytes for use with apache-arrow. */
  intoIPCStream(): Uint8Array;
}

// ── apache-arrow ──

declare module 'apache-arrow' {
  /** Deserialize an Arrow IPC stream into a Table. */
  export function tableFromIPC(ipcStream: Uint8Array): ArrowTable;

  interface ArrowTable {
    /** Get a column (Vector) by name. Returns null if not found. */
    getChild(name: string): ArrowVector | null;
    /** Number of rows. */
    numRows: number;
  }

  interface ArrowVector {
    /** Materialize the entire column as a typed array or JS array. */
    toArray(): unknown;
    /** Get a single element by row index. */
    get(index: number): unknown;
    /** Number of elements. */
    length: number;
  }
}
