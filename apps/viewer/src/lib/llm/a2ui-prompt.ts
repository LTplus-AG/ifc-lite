/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adds the A2UI section to a built system prompt. The section is rendered by
 * the agent parser, which loads lazily on the first chat turn and is cached
 * after that. The personal overlay stays last, so the shared prefix of the
 * prompt stays cacheable.
 */

/** Heading `buildSystemPrompt` puts before the personal overlay. */
export const PERSONAL_CONTEXT_HEADING = '\n\n## PERSONAL CONTEXT';

let section: Promise<string> | undefined;

export function loadA2uiPromptSection(): Promise<string> {
  section ??= import('@/lib/a2ui/prompt')
    .then((m) => m.buildA2uiPromptSection())
    .catch((error: unknown) => {
      // The chat still works without surfaces; try again next turn.
      console.warn('[chat] A2UI prompt section unavailable', error);
      section = undefined;
      return '';
    });
  return section;
}

export function insertA2uiSection(prompt: string, a2ui: string): string {
  if (!a2ui) return prompt;
  const at = prompt.lastIndexOf(PERSONAL_CONTEXT_HEADING);
  return at === -1 ? `${prompt}\n\n${a2ui}` : `${prompt.slice(0, at)}\n\n${a2ui}${prompt.slice(at)}`;
}

export async function withA2uiPrompt(prompt: string): Promise<string> {
  return insertA2uiSection(prompt, await loadA2uiPromptSection());
}
