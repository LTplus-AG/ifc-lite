/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/mcp/bridge-protocol`: the browser-safe frame protocol between an
 * ifc-lite MCP bridge and its paired viewer tab (#9523). See `protocol.ts`
 * for the frames and the tab's read-only obligation.
 */

export * from './protocol.js';
export * from './pairing-link.js';
