/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The model server's `initialize` instructions; `--bridge` appends its own (bridge/run.ts). */
export const SERVER_INSTRUCTIONS = `
ifc-lite-mcp exposes a federated set of IFC/BIM models as MCP tools.

Conventions:
  • All tools accept an optional model_id; when only one model is loaded it can be omitted.
  • Errors surface as tool results with isError=true and structuredContent.code (e.g. ENTITY_NOT_FOUND).
  • Long operations stream progress via notifications/progress when a progressToken is supplied.
  • Mutations are queued; call export_ifc or model_save to persist.

See the resource ifc-lite://server/manifest for the full tool catalog.
`.trim();
