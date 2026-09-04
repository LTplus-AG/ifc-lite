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

// The package's own entry point (`parquet-wasm`), not a build-specific deep
// path: `esm/arrow2.js` was dropped in parquet-wasm 0.6, so importing it
// broke for any consumer on the version the rest of this workspace pins
// (#3845). The bare specifier lets the package's export map pick the build:
// the Node build (auto-initializing, no default export) under Node, the
// wasm-bindgen ESM build (whose default export must be awaited before any
// other call) in a browser or bundler.
declare module 'parquet-wasm' {
  /** Initialize WASM module. Browser/bundler build only; absent on Node. */
  export default function init(wasmUrlOrResponse?: string | Response): Promise<void>;
  /** Read a Parquet buffer and return an Arrow IPC-compatible table. */
  export function readParquet(data: Uint8Array): ParquetTable;
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
