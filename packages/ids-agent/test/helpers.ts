/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared fixtures: schema contexts (loaded once), documents and op builders. */

import {
  apply,
  createLintContext,
  createStudioDocument,
  deriveId,
  type FacetDraft,
  type GateContext,
  type LintContext,
  type StudioDocument,
  type StudioOp,
  type Uuid,
} from '@ifc-lite/ids-authoring';
import { createSandbox, type Sandbox } from '../src/sandbox/sandbox.js';
import type { AgentToolContext } from '../src/tools/context.js';
import { firstChoice, type AskUserHandler, type BsddClient, type ModelBridge } from '../src/bridges.js';

let contexts: Promise<{ gate: GateContext; lint: LintContext }> | undefined;

export function schemaContexts(): Promise<{ gate: GateContext; lint: LintContext }> {
  contexts ??= (async () => {
    const lint = await createLintContext();
    return { gate: lint.gate, lint };
  })();
  return contexts;
}

let counter = 0;
/** Deterministic test ids. */
export const id = (): Uuid => deriveId('ids-agent-test', String(counter++));

export const eq = (value: string | number | boolean) => ({ kind: 'equals' as const, value });

export function entity(name: string): FacetDraft {
  return { type: 'entity', name: eq(name) };
}

export function property(pset: string, name: string): FacetDraft {
  return { type: 'property', propertySet: eq(pset), baseName: eq(name) };
}

/** An empty document, or one with a door specification requiring a fire rating. */
export function emptyDoc(): StudioDocument {
  return createStudioDocument({ title: 'Test', newId: id });
}

export function doorDoc(): { doc: StudioDocument; specId: Uuid } {
  const specId = id();
  const ops: StudioOp[] = [
    { kind: 'spec.add', opId: id(), payload: { specId, name: 'Doors', ifcVersions: ['IFC4'] } },
    { kind: 'facet.add', opId: id(), payload: { specId, section: 'applicability', facetId: id(), facet: entity('IfcDoor') } },
    { kind: 'facet.add', opId: id(), payload: { specId, section: 'requirements', facetId: id(), facet: property('Pset_DoorCommon', 'FireRating') } },
  ];
  return { doc: apply(emptyDoc(), ops).doc, specId };
}

/** Ops that add a door specification using handles, as a model would write them. */
export function doorOps(pset = 'Pset_DoorCommon', prop = 'FireRating', handle = '@doors'): unknown[] {
  return [
    { kind: 'spec.add', payload: { specId: handle, name: 'Door fire rating', ifcVersions: ['IFC4'] } },
    { kind: 'facet.add', payload: { specId: handle, section: 'applicability', facetId: `${handle}-app`, facet: entity('IfcDoor') } },
    { kind: 'facet.add', payload: { specId: handle, section: 'requirements', facetId: `${handle}-req`, facet: property(pset, prop) } },
  ];
}

export async function sandboxFor(doc: StudioDocument = emptyDoc(), runId = id()): Promise<Sandbox> {
  const { gate, lint } = await schemaContexts();
  return createSandbox({ doc, gate, lint, runId, model: 'test-model' });
}

export async function toolContext(sandbox: Sandbox, extra: { model?: ModelBridge; bsdd?: BsddClient; askUser?: AskUserHandler } = {}): Promise<AgentToolContext> {
  const { gate } = await schemaContexts();
  return { sandbox, gate, askUser: extra.askUser ?? firstChoice, signal: new AbortController().signal, callId: 'call-test',
    ...(extra.model ? { model: extra.model } : {}), ...(extra.bsdd ? { bsdd: extra.bsdd } : {}) };
}
