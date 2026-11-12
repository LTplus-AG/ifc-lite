/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Types for check-schema-tables-lazy.mjs, the viewer build's gate against decoding schema tables at boot. */
export declare const SCHEMA_TABLE_MARKER: string;
export declare const SCHEMA_TABLE_PAYLOAD: string;
export declare function checkSchemaTablesLazy(directory: string): Promise<{ eager: string[]; lazy: string[] }>;
