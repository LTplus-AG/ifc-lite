/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Types for check-rhino3dm-lazy.mjs, the viewer build's rhino3dm startup-graph gate. */
export declare const RHINO3DM_SIGNATURES: readonly string[];
export declare function checkRhino3dmLazy(directory: string): Promise<{ eager: string[]; lazy: string[] }>;
