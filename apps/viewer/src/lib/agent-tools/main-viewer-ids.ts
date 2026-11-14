/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS tools as the main viewer serves them: the XML arrives inline in the
 * call, and the validation report goes back to the caller and nowhere else
 * (no staged download, no file the tab writes).
 */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { explainIds, validateIdsAgainst } from './ids-tools.js';
import type { ModelFreeTool, ModelTool } from './types.js';

/** The IDS XML carried by the call. A path is refused: the tab cannot read the agent's disk. */
export function inlineIdsXml(args: Record<string, unknown>): string {
  const path = [args.ids_path, args.path, args.file_path].find((value) => typeof value === 'string' && value.trim() !== '');
  if (path !== undefined) {
    throw new ToolExecutionError({
      code: ToolErrorCode.INVALID_INPUT,
      message: `The viewer cannot read files from the agent's disk ('${String(path)}'). Pass the IDS document itself as ids_xml.`,
    });
  }
  const xml = typeof args.ids_xml === 'string' ? args.ids_xml.trim() : '';
  if (!xml) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: '`ids_xml` (the IDS document as XML text) is required.' });
  }
  return xml;
}

const ids_validate: ModelTool = {
  needs: 'source',
  async run(_host, model, args, ctx) {
    return (await validateIdsAgainst(model, inlineIdsXml(args), ctx)).output;
  },
};

const ids_explain: ModelFreeTool = {
  needs: 'none',
  async run(_host, args) {
    return explainIds(inlineIdsXml(args));
  },
};

export const mainViewerIdsTools = { ids_validate, ids_explain };
