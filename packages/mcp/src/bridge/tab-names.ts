/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TAB_TOOL_PREFIX } from './protocol.js';

/** The MCP name of a tab tool: the tab's own name under `tab_`. */
export function mcpName(tabName: string): string {
  return TAB_TOOL_PREFIX + tabName;
}
