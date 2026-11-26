/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The merged IfcProject's RepresentationContexts: a compatible later model's IfcProject folds into the primary's, so
 * the contexts it kept are listed there (#10798).
 */

import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { frameArgs, stepRecordFrame, withFrameArgs } from './step-record-frame.js';

/** 0-based attribute index of `IfcContext.RepresentationContexts` (IfcProject in IFC2X3 and IFC4, IfcProjectLibrary). */
export const PROJECT_REPRESENTATION_CONTEXTS_ATTR = 7;

/** The `#N` references in an attribute slot of references (`$` has none); its comments are not read. */
export const refsIn = (slot: string): string[] => slot.replace(/\/\*[\s\S]*?\*\//g, '').match(/#\d+/g) ?? [];

/**
 * List `contextIds` in the merged project's RepresentationContexts (#10798). A compatible later model's IfcProject
 * folds into the primary's, so a top-level context of it that was kept rather than unified (a different frame or
 * georeference, or a second context its own project listed) belongs to no project otherwise. Only
 * ids written to `lines` are listed.
 */
export function listKeptContexts(lines: string[], projectId: number | undefined, contextIds: readonly number[]): void {
  if (projectId === undefined || contextIds.length === 0) return;
  const wanted = new Set(contextIds), written: number[] = [];
  let projectIndex = -1;
  // Stops once the project and every kept context are found.
  for (let index = 0; index < lines.length && (projectIndex < 0 || written.length < wanted.size); index++) {
    const id = leadingId(lines[index]);
    if (id === projectId) projectIndex = index;
    else if (wanted.has(id)) written.push(id);
  }
  if (projectIndex < 0 || written.length === 0) return;
  const text = lines[projectIndex], frame = stepRecordFrame(text, { allowMissingSemicolon: true });
  const args = frame && splitTopLevelStepArguments(frameArgs(text, frame));
  if (!frame || !args || args.length <= PROJECT_REPRESENTATION_CONTEXTS_ATTR) return;
  // The slot holds references only, so it is rewritten from them: `(#2) /* c */` and `$ /* c */` read as the list.
  args[PROJECT_REPRESENTATION_CONTEXTS_ATTR] = `(${[...refsIn(args[PROJECT_REPRESENTATION_CONTEXTS_ATTR]), ...written.map(id => `#${id}`)].join(',')})`;
  lines[projectIndex] = withFrameArgs(text, frame, args.join(','));
}

/** The `#N` a STEP line starts with, or -1; read by char code, as it runs over every line of a merge. */
function leadingId(line: string): number {
  if (line.charCodeAt(0) !== 35) return -1;
  let id = 0, index = 1;
  for (; index < line.length; index++) {
    const digit = line.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) break;
    id = id * 10 + digit;
  }
  return index > 1 ? id : -1;
}
