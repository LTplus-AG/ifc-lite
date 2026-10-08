/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parameter declarations of the live Flow registry, published by `runner.ts`
 * when it creates the registry. Evidence code (`flowRun`, #6919) classifies
 * parameters through this handle so the main bundle never imports the node
 * runtime. No registry yet means no run happened in this session.
 */

import type { ParamDef } from '@ifc-lite/flow';

type ParamDefs = (type: string) => readonly ParamDef[] | undefined;
let published: ParamDefs | null = null;

export function publishFlowParamDefs(defs: ParamDefs): void {
  published = defs;
}

/** `null`: no registry is loaded; `undefined`: the registry has no such node type. */
export function flowParamDefs(type: string): readonly ParamDef[] | undefined | null {
  return published ? published(type) : null;
}
