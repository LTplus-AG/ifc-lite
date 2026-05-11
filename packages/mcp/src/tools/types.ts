/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CallToolResult, JsonSchema, ToolScope } from '../protocol/index.js';
import type { ToolContext } from '../context.js';

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  scope?: ToolScope;
  handler(input: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> | CallToolResult;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
