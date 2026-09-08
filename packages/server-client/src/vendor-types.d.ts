/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal ambient type declarations for apache-arrow.
 *
 * These cover only the API surface actually used in this package,
 * avoiding the need for @ts-ignore on every call site.
 *
 * parquet-wasm is NOT declared here: it ships its own `.d.ts` per build and
 * they resolve fine from this package's tsconfig. An ambient stub would
 * shadow them (#3845). See `parquet-decoder.ts` for the one place the real
 * types need help: they describe whichever build the resolver picked, and
 * the runtime may be the other one.
 */

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
