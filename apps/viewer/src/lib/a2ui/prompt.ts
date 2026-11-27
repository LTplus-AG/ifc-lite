/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The chat's A2UI system-prompt section (lazy: it needs the agent parser to
 * render the catalog snippet). The snippet teaches the Express grammar and
 * every IFC catalog component; the rules above it are the viewer's own.
 */

import { createIfcAgent } from '@ifc-lite/a2ui/agent';

export const A2UI_CHAT_RULES = `## INTERACTIVE ANSWERS (A2UI)
You can add interactive result views to a reply with <a2ui>…</a2ui> blocks in A2UI Express. The viewer renders them inline, in order, between your text.
- Use them for results the user will look at or act on: element tables, KPI tiles, charts, colour legends and 3D actions.
- Facts come from the model, never from you. Give IFC components a query, or bind data a bim script computed. Never type counts, names or quantities into Text.
- When a question needs computation a query cannot express, write a bim script instead of a surface.
- Put all UI for one reply in one <a2ui> block. A second block must start with surface("details") (any new id).
- Never wrap an <a2ui> block in a code fence; fences are for bim scripts only.`;

export function buildA2uiPromptSection(): string {
  return `${A2UI_CHAT_RULES}\n\n${createIfcAgent().promptSnippet}`;
}
