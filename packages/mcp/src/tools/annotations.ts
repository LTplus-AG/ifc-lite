/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * MCP tool annotation presets. Every hint is set explicitly because the spec
 * defaults are the cautious ones (`destructiveHint` and `openWorldHint`
 * default to true), so an omitted hint would claim more than the tool does.
 *
 * "Environment" is the session: loaded models, pending mutations, BCF and
 * layer state, the viewer, files on disk. A queued mutation that
 * `mutation_undo` can revert still changes the environment.
 */

import type { ToolAnnotations } from '../protocol/index.js';

function hints(readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint = false): Readonly<ToolAnnotations> {
  return Object.freeze({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });
}

/** Reads models, session state or input files and changes nothing. */
export const READ_ONLY = hints(true, false, true);
/** Read only, but calls an external service (bSDD). */
export const READ_ONLY_NETWORK = hints(true, false, true, true);
/** Changes only what the viewer shows; the model is untouched. */
export const VIEWER_DISPLAY = hints(false, false, true);
/** Adds to the session (new elements, topics, layers); each call adds again. */
export const EDIT = hints(false, false, false);
/** Sets a value; repeating the same call leaves the same state. */
export const EDIT_IDEMPOTENT = hints(false, false, true);
/** Deletes, overwrites or removes data; repeating the call changes nothing more. */
export const DESTRUCTIVE = hints(false, true, true);
/** May delete or discard data, and each call can do so again. */
export const DESTRUCTIVE_NOT_IDEMPOTENT = hints(false, true, false);
/** Writes a file to disk and may overwrite one at the same path. */
export const FILE_WRITE = hints(false, true, true);
/** Runs a Flow graph, which may edit the model and call external services. */
export const FLOW_RUN = hints(false, true, false, true);

