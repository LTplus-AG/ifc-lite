/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GetPromptResult, PromptArgument, PromptDefinition } from '../protocol/index.js';
import type { ToolContext } from '../context.js';

export interface Prompt {
  name: string;
  description: string;
  arguments?: PromptArgument[];
  /** Build the message list. Receives validated string args. */
  render(args: Record<string, string>, ctx: ToolContext): Promise<GetPromptResult> | GetPromptResult;
}

export class PromptRegistry {
  private prompts = new Map<string, Prompt>();

  register(prompt: Prompt): void {
    if (this.prompts.has(prompt.name)) {
      throw new Error(`Duplicate prompt registration: ${prompt.name}`);
    }
    this.prompts.set(prompt.name, prompt);
  }

  registerAll(prompts: Prompt[]): void {
    for (const p of prompts) this.register(p);
  }

  get(name: string): Prompt | null {
    return this.prompts.get(name) ?? null;
  }

  list(): PromptDefinition[] {
    return Array.from(this.prompts.values()).map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    }));
  }
}
