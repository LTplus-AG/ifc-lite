/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identity and trust policy for the IFC catalog. One table decides what a
 * surface may do without asking: renderers consult it rather than keeping
 * their own lists.
 */

export const A2UI_PROTOCOL_VERSION = '1.0' as const;
export const IFC_CATALOG_ID = 'https://ifclite.dev/a2ui/catalogs/ifc/v1/catalog.json';
/** MIME type MCP tools use for A2UI payloads (A2UI MCP Apps guide). */
export const A2UI_MIME_TYPE = 'application/a2ui+json';

/**
 * - `view`: changes only what the 3D view shows; reversible, runs on click.
 * - `read`: returns data, no side effects.
 * - `file`: writes a file for the user; needs a user gesture.
 */
export type FunctionEffect = 'view' | 'read' | 'file';

export interface FunctionPolicy {
  effect: FunctionEffect;
  /** May the agent call it through `callRendererFunction`? */
  agentCallable: boolean;
  /** Must it run from a user gesture? (A2UI `requiresUserActivation`) */
  userActivation: boolean;
}

export const IFC_FUNCTION_POLICY = {
  select: { effect: 'view', agentCallable: true, userActivation: false },
  isolate: { effect: 'view', agentCallable: true, userActivation: false },
  hide: { effect: 'view', agentCallable: true, userActivation: false },
  show: { effect: 'view', agentCallable: true, userActivation: false },
  colorize: { effect: 'view', agentCallable: true, userActivation: false },
  flyTo: { effect: 'view', agentCallable: true, userActivation: false },
  resetView: { effect: 'view', agentCallable: true, userActivation: false },
  getSelection: { effect: 'read', agentCallable: true, userActivation: false },
  countEntities: { effect: 'read', agentCallable: true, userActivation: false },
  sumQuantity: { effect: 'read', agentCallable: true, userActivation: false },
  exportCsv: { effect: 'file', agentCallable: false, userActivation: true },
} as const satisfies Record<string, FunctionPolicy>;

export type IfcFunctionName = keyof typeof IFC_FUNCTION_POLICY;

export function isIfcFunction(name: string): name is IfcFunctionName {
  return Object.prototype.hasOwnProperty.call(IFC_FUNCTION_POLICY, name);
}

/** Actions an `ActionBar` may offer. Each maps to one IFC function. */
export const VIEWER_ACTIONS = ['select', 'isolate', 'hide', 'show', 'colorize', 'flyTo', 'resetView', 'exportCsv'] as const;
export type ViewerAction = (typeof VIEWER_ACTIONS)[number];

/**
 * Agent events (`Event("name", {...})`) never execute anything locally. The
 * renderer turns them into a follow-up chat turn. `ask` carries a prompt the
 * user sees before it is sent; any other name is described to the agent as
 * "the user did X with context Y".
 */
export const ASK_EVENT = 'ask';

export interface FollowUp {
  /** Text shown in the chat as the user's message. */
  userText: string;
  /** Structured context passed along to the agent. */
  context: Record<string, unknown>;
}

export function eventToFollowUp(name: string, context: Record<string, unknown> | undefined, userMessage?: string): FollowUp {
  const ctx = context ?? {};
  if (name === ASK_EVENT && typeof ctx.prompt === 'string' && ctx.prompt.trim()) {
    return { userText: ctx.prompt.trim(), context: ctx };
  }
  const label = userMessage?.trim() || `Action: ${name}`;
  return { userText: label, context: { event: name, ...ctx } };
}
