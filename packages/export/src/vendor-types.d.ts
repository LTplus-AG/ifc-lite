/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal ambient type declarations for apache-arrow and parquet-wasm
 * used in the Parquet exporter.
 */

declare module 'apache-arrow' {
  export function vectorFromArray(data: unknown[], type?: unknown): unknown;
  export function tableToIPC(table: unknown, format: string): ArrayBuffer;
  export class Table {
    constructor(vectors: Record<string, unknown>);
  }
  export class Float64 {}
  export class Int32 {}
  export class Bool {}
}

declare module 'parquet-wasm' {
  export class Table {
    static fromIPCStream(buffer: ArrayBuffer): Table;
  }
  export function writeParquet(table: Table): ArrayBuffer;
}
