/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Columns to Parquet bytes.
 *
 * Extracted from `ParquetExporter` so a caller with a table that is NOT an
 * `IfcDataStore` view - the viewer's per-element x per-zone breakdown (#2508)
 * is the first - writes the same bytes through the same type inference rather
 * than growing a second Arrow-to-Parquet path beside it. `ParquetExporter`
 * itself now calls this.
 *
 * Falls back to Arrow IPC when `parquet-wasm` cannot load, which is still a
 * binary format most tools read, and says so on the console rather than
 * failing the export.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * @param columns column name to values, all arrays the same length
 * @param floatColumns names that must be Float64 even when every value in the
 *   sample happens to be a whole number - content inference alone would demote
 *   `3.0` to Int32, losing the schema and risking wrap beyond 2^31
 */
export async function columnsToParquet(
    columns: Record<string, any[]>,
    floatColumns?: Set<string>,
): Promise<Uint8Array> {
    try {
        // Dynamic imports for better tree-shaking. The package's
        // browser/node exports map keeps `Arrow.dom.mjs` opaque to
        // TS5's strict resolver, so the import is typed `any` here
        // and consumers fall back to runtime checks. See:
        // https://github.com/apache/arrow/issues/35835
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const arrow: any = await import('apache-arrow');

        // Build Arrow vectors from column data
        const vectors: Record<string, any> = {};

        for (const [name, data] of Object.entries(columns)) {
            if (data.length === 0) {
                // No rows at all: same reasoning as the all-null case
                // below - an untyped empty column is Arrow's Null type,
                // which the Parquet writer rejects.
                vectors[name] = floatColumns?.has(name)
                    ? arrow.vectorFromArray([], new arrow.Float64())
                    : arrow.vectorFromArray([], new arrow.Utf8());
                continue;
            }

            // Infer type from first non-null element
            const sample = data.find((v) => v !== null && v !== undefined);

            if (sample === undefined) {
                // All nulls. A caller that DECLARED the column numeric gets
                // Float64 anyway: inference alone would give it Arrow's Null
                // type, which parquet-wasm cannot write, and the failure lands
                // in the catch below - so the whole table silently degrades to
                // Arrow IPC because one column happened to be empty. Reachable
                // here whenever no element in a zone set could be measured.
                vectors[name] = floatColumns?.has(name)
                    ? arrow.vectorFromArray(data, new arrow.Float64())
                    : arrow.vectorFromArray(data, new arrow.Utf8());
            } else if (typeof sample === 'number') {
                // Columns declared as REAL-typed by the caller (e.g. ValueReal,
                // quantity Value) always use Float64 — content inference alone
                // would demote whole-number reals like 3.0/1200.0 to Int32,
                // losing the float schema and risking wrap for |x| > 2^31.
                if (floatColumns?.has(name)) {
                    vectors[name] = arrow.vectorFromArray(data, new arrow.Float64());
                    continue;
                }
                // Otherwise check if it's integer or float by content.
                const isFloat = data.some((v) => typeof v === 'number' && !Number.isInteger(v));
                if (isFloat) {
                    vectors[name] = arrow.vectorFromArray(data, new arrow.Float64());
                } else {
                    // Use Int32 for integers (covers express IDs and most counts)
                    vectors[name] = arrow.vectorFromArray(data, new arrow.Int32());
                }
            } else if (typeof sample === 'boolean') {
                vectors[name] = arrow.vectorFromArray(data, new arrow.Bool());
            } else {
                // String or other - convert to string
                vectors[name] = arrow.vectorFromArray(data.map((v) => v === null ? null : String(v)));
            }
        }

        // Build Arrow Table
        const table = new arrow.Table(vectors);

        // Convert to Arrow IPC format
        const ipcBuffer = arrow.tableToIPC(table, 'stream');

        // Try to use parquet-wasm for conversion
        try {
            const parquet: any = await import('parquet-wasm');

            // The package resolves to its wasm-bindgen ESM build in a BROWSER,
            // and that build does nothing until its default export is awaited:
            // without this every call threw `Cannot read properties of
            // undefined (reading '__wbindgen_malloc')` and fell through to the
            // Arrow IPC branch below - silently, since the fallback only warns,
            // so the download was named `.parquet` and was not Parquet. The
            // Node build auto-initialises and exposes no default init, hence
            // the guard rather than an unconditional call.
            if (typeof parquet.default === 'function') await parquet.default();

            // parquet-wasm 0.5+ API: read Arrow IPC and write Parquet
            const arrowTable = parquet.Table.fromIPCStream(ipcBuffer);
            const parquetBuffer = parquet.writeParquet(arrowTable);

            return new Uint8Array(parquetBuffer);
        } catch (parquetError) {
            // Fallback: If parquet-wasm fails, return Arrow IPC format instead
            // This is still a valid binary format that can be read by many tools
            console.warn('[columnsToParquet] parquet-wasm conversion failed, returning Arrow IPC format:', parquetError);
            return new Uint8Array(ipcBuffer);
        }
    } catch (error) {
        // If all else fails, throw a descriptive error
        throw new Error(`Failed to convert to Parquet format: ${error}. Ensure apache-arrow and parquet-wasm are installed.`);
    }
}

/** Parquet's file magic, at both ends of the file. */
const PARQUET_MAGIC = 'PAR1';

/**
 * Are these bytes actually Parquet, or the Arrow IPC fallback?
 *
 * For callers that put the format in a FILENAME. A `.parquet` file containing
 * Arrow IPC opens in nothing the extension promises, and the reader is told the
 * file is corrupt rather than that it is a different format.
 */
export function isParquet(bytes: Uint8Array): boolean {
    if (bytes.byteLength < 8) return false;
    const head = String.fromCharCode(...bytes.subarray(0, 4));
    const tail = String.fromCharCode(...bytes.subarray(bytes.byteLength - 4));
    return head === PARQUET_MAGIC && tail === PARQUET_MAGIC;
}
