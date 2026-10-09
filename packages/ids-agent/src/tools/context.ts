/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GateContext } from '@ifc-lite/ids-authoring';
import type { JsonSchema } from '@ifc-lite/ids-authoring';
import type { AskUserHandler, BsddClient, ModelBridge } from '../bridges.js';
import type { Sandbox } from '../sandbox/sandbox.js';
import type { AgentTool } from './registry.js';

/** What a tool handler can reach during one call. */
export interface AgentToolContext {
  readonly sandbox: Sandbox;
  readonly gate: GateContext;
  readonly model?: ModelBridge;
  readonly bsdd?: BsddClient;
  readonly askUser: AskUserHandler;
  readonly signal: AbortSignal;
  /** The provider's id of the call being answered. */
  readonly callId: string;
}

export type IdsAgentTool = AgentTool<AgentToolContext>;

/** IFC versions an IDS specification can name. */
export const IFC_VERSIONS = ['IFC2X3', 'IFC4', 'IFC4X3_ADD2'] as const;

export const versionSchema: JsonSchema = { enum: IFC_VERSIONS, description: 'IFC schema version of the specification.' };

/** A closed object schema (what strict tool use requires). */
export function objectSchema(properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Clamp a caller-supplied limit; the schema interpreter has no `maximum`. */
export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

/** Cap a string sent to the model (values read from a model are data, never instructions). */
export function capText(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
