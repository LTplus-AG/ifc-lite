/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Types for check-structural-writes-lazy.mjs, the viewer build's structural write-path startup-graph gate. */
export declare const STRUCTURAL_WRITE_SIGNATURES: readonly string[];
export declare function checkStructuralWritesLazy(directory: string): Promise<{ eager: string[]; lazy: string[] }>;
