/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { parseCapabilities } from '@ifc-lite/extensions';
import { createNativeBcfWriteGateway } from '@ifc-lite/flow-nodes/bcf-publication-node';
import type { ToolContext } from '../context.js';
import { scopeAllows } from '../auth/scope.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { Tool } from './types.js';
import { okResult } from './util.js';

/** Stable across authenticated sessions; local stdio shares the CLI journal. */
export function mcpPublicationNamespace(ctx: ToolContext, requiresStableIdentity = true): string | undefined {
  const principal = ctx.session?.principal ?? ctx.scope.user;
  if (requiresStableIdentity && ctx.session?.id !== undefined && principal === undefined) {
    throw new ToolExecutionError({ code: ToolErrorCode.PERMISSION_DENIED,
      message: 'Remote BCF publication requires a stable authenticated principal so recovery survives session restart.' });
  }
  return principal === undefined ? undefined : `mcp-${createHash('sha256').update(principal).digest('hex')}`;
}

function authorize(ctx: ToolContext, scope: 'read' | 'mutate'): void {
  if (!scopeAllows(ctx.scope, scope) || (scope === 'mutate' && ctx.config.readOnly)) {
    throw new ToolExecutionError({ code: ToolErrorCode.PERMISSION_DENIED, message: `BCF publication recovery requires ${scope} authorization.` });
  }
}
function required(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `${key} must be a nonempty string.` });
  }
  return value;
}
const entryProperty = { entry_id: { type: 'string', description: 'Durable publication id returned by bcf_publications_list.' } } as const;

const list: Tool = {
  name: 'bcf_publications_list', scope: 'read',
  description: 'List credential-free native Flow BCF publication intents, unresolved outcomes and receipts for the current principal. Does not contact a server.',
  inputSchema: { type: 'object', properties: {
    cursor: { type: 'string', description: 'Opaque nextCursor from the preceding page; follow even empty progress pages.' },
    limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum entries in this bounded page (default 100).' },
  }, additionalProperties: false },
  async handler(input, ctx) {
    authorize(ctx, 'read');
    if (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor)) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'cursor must be a nonempty string.' });
    }
    if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'limit must be an integer from 1 to 1000.' });
    }
    const page = await createNativeBcfWriteGateway({ namespace: mcpPublicationNamespace(ctx) }).listPage({
      cursor: typeof input.cursor === 'string' ? input.cursor : undefined,
      limit: typeof input.limit === 'number' ? input.limit : undefined,
    });
    return okResult(`${page.entries.length} durable BCF publication(s) in this page.`, { ...page });
  },
};
const check: Tool = {
  name: 'bcf_publication_check', scope: 'mutate',
  description: 'Read the original BCF target under explicitly supplied network.fetch grants and persist actual matching candidate GUIDs. Never sends a write or blindly retries. token_env needs its exact secret.read grant; unsafe credential-bearing results are refused; protocol keys and identifiers are preserved.',
  inputSchema: { type: 'object', properties: { ...entryProperty,
    capabilities: { type: 'array', items: { type: 'string' }, description: 'Explicit current network.fetch:<host> and optional secret.read:<NAME> grants; no prior run grant is reused.' },
    token_env: { type: 'string', description: 'Environment variable containing the BCF bearer token, authorized by secret.read:<NAME>.' },
    confirm_full_read_access: { type: 'boolean', description: 'Explicit caller confirmation that this read sees the original write’s full access scope. A bearer token alone never proves visibility; required before an empty collection can prove absence.' },
    confirm_owner_stopped: { type: 'boolean', description: 'Persist an explicit operator assertion for an unverifiable sender. Never overrides an observed live process.' },
  }, required: ['entry_id', 'capabilities'], additionalProperties: false },
  async handler(input, ctx) {
    authorize(ctx, 'mutate');
    if (!Array.isArray(input.capabilities) || !input.capabilities.every(value => typeof value === 'string')) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'capabilities must be an array of capability strings.' });
    }
    const parsed = parseCapabilities(input.capabilities);
    if (!parsed.ok || parsed.value.some(capability =>
      !((capability.scope === 'network' && capability.action === 'fetch') || (capability.scope === 'secret' && capability.action === 'read')))) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Only valid network.fetch and secret.read capabilities are accepted.' });
    }
    if (input.confirm_owner_stopped !== undefined && typeof input.confirm_owner_stopped !== 'boolean') {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'confirm_owner_stopped must be boolean.' });
    }
    if (input.confirm_full_read_access !== undefined && typeof input.confirm_full_read_access !== 'boolean') {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'confirm_full_read_access must be boolean.' });
    }
    let token: string | undefined;
    if (input.token_env !== undefined) {
      const name = required(input, 'token_env');
      if (!input.capabilities.includes(`secret.read:${name}`)) {
        throw new ToolExecutionError({ code: ToolErrorCode.PERMISSION_DENIED, message: 'token_env requires its exact secret.read capability.' });
      }
      token = process.env[name]?.trim();
      if (!token) {
        throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'token_env must name a set nonempty secret.' });
      }
    }
    const secrets = token ? [token] : [];
    const gateway = createNativeBcfWriteGateway({ namespace: mcpPublicationNamespace(ctx), secrets });
    const entry = await gateway.check(required(input, 'entry_id'), { token, networkGrants: parsed.value, signal: ctx.signal,
      confirmOwnerStopped: input.confirm_owner_stopped === true, confirmFullReadAccess: input.confirm_full_read_access === true });
    // Native strict decoding rejects credential values before return; keep fixed
    // protocol keys and recorded identifiers intact (including short bearers).
    return okResult('BCF publication checked; review candidates before reconciliation.', { entry });
  },
};
const reconcile: Tool = {
  name: 'bcf_publication_reconcile', scope: 'mutate',
  description: 'Bind an intent to one GUID previously obtained and durably checked at its original target with the same payload. Makes no network write. Refuses arbitrary GUIDs and live send ownership; the receipt survives process restart.',
  inputSchema: { type: 'object', properties: { ...entryProperty,
    candidate_guid: { type: 'string', description: 'An exact GUID from the persisted matching check candidates.' },
  }, required: ['entry_id', 'candidate_guid'], additionalProperties: false },
  async handler(input, ctx) {
    authorize(ctx, 'mutate');
    const gateway = createNativeBcfWriteGateway({ namespace: mcpPublicationNamespace(ctx) });
    const entry = await gateway.reconcile(required(input, 'entry_id'), required(input, 'candidate_guid'));
    return okResult('BCF publication reconciled without sending a write.', { entry });
  },
};

const confirmAbsent: Tool = {
  name: 'bcf_publication_confirm_absent', scope: 'mutate',
  description: 'Explicitly confirm absence only after the latest complete persisted server check found an empty collection with explicit full original access-scope confirmation. Old markerless or unconfirmed checks cannot release an intent. Makes no write; releases the intent for a separately reviewed later run. Failed or partial checks and live send ownership cannot release it.',
  inputSchema: { type: 'object', properties: entryProperty, required: ['entry_id'], additionalProperties: false },
  async handler(input, ctx) {
    authorize(ctx, 'mutate');
    const gateway = createNativeBcfWriteGateway({ namespace: mcpPublicationNamespace(ctx) });
    const entry = await gateway.confirmAbsent(required(input, 'entry_id'));
    return okResult('BCF publication explicitly confirmed absent; no write was sent.', { entry });
  },
};

export const bcfPublicationTools: Tool[] = [list, check, reconcile, confirmAbsent];
