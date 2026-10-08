/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/ids-authoring — the headless IDS authoring core.
 *
 * Every authoring surface (UI, AI agent, imports, CLI, MCP) changes an IDS
 * only by dispatching the typed operations defined here. See
 * `docs/architecture/ids-studio/03-architecture/02-document-model-and-ops.md`.
 */

export { uuidv7, deriveId, isUuid, type Uuid, type UuidV7Source } from './uuid.js';
