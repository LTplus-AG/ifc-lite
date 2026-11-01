/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Types for no-external-network.mjs, the viewer tests' offline harness. */
export declare function connectTarget(args: unknown[]): { host: string; port: unknown } | null;
export declare function isLoopback(host: string): boolean;
