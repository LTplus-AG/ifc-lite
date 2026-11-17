/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one module a local-agent bridge client imports (lazily, with
 * `import()`) to serve the main viewer's model (#9523), read-only unless the
 * user allows edits:
 *
 *   const editor = createMainViewerEditor(useViewerStore);
 *   const host = createMainViewerToolHost(useViewerStore, bim, { editor });   // bim = useBim()
 *   const tools = mainViewerToolDefinitions();                                 // send at handshake
 *   const result = await dispatchMainViewerTool(host, name, args, { signal, canEdit });
 */

export { createMainViewerToolHost, type MainViewerToolHostOptions } from './main-viewer-host.js';
export { createMainViewerEditor } from './main-viewer-edits.js';
export {
  MAIN_VIEWER_EDIT_TOOLS,
  MAIN_VIEWER_TOOL_ALLOWLIST,
  dispatchMainViewerTool,
  type AgentToolResult,
  type MainViewerToolName,
} from './main-viewer-dispatch.js';
export { mainViewerToolDefinitions, type AgentToolDefinition } from './main-viewer-tool-definitions.js';
