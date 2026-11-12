/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Frame protocol between an ifc-lite MCP bridge and the one viewer tab paired
 * with it (#9523). Exported as `@ifc-lite/mcp/bridge-protocol`.
 *
 * This module must stay browser-safe: no `node:*` import, no Buffer, no
 * process. The tab imports it to build and check the same frames the bridge
 * checks.
 *
 * The frames are transport-neutral: each is one UTF-8 JSON text object with a
 * `type` field, carried in order over one bidirectional message channel per
 * tab. Nothing in the frame types names an address or a transport. Today's one
 * transport is `ifc-lite-mcp --bridge`'s loopback WebSocket
 * (`ws://127.0.0.1:<port>/`, default port {@link DEFAULT_BRIDGE_PORT}, binary
 * frames rejected, fatal errors mapped to {@link BridgeCloseCode}). Another
 * transport may carry the same frames later.
 *
 * Sequence:
 *
 *   tab    -> bridge  hello    { protocol, pairingCode, permission, tools, client? }
 *   bridge -> tab     welcome  { protocol, sessionId, permission, readOnlyCeiling, bridge }
 *   bridge -> tab     call     { sessionId, id, name, arguments }
 *   tab    -> bridge  result   { sessionId, id, result }
 *   bridge -> tab     cancel   { sessionId, id, reason }
 *   tab    -> bridge  update   { sessionId, permission?, tools? }
 *   bridge -> tab     error    { code, message }  (followed by a close on fatal codes)
 *
 * `hello` must be the first frame and arrive within the handshake timeout.
 * `sessionId` is issued in `welcome` and every later tab frame must carry it.
 * A `result` whose `sessionId` or `id` does not name a call still pending on
 * that channel is ignored, so a reply from an earlier tab, an unknown id or
 * a duplicate never answers a current call.
 *
 * Read-only obligation (tab side). The bridge decides whether a tool mutates
 * ONLY from the tab's own `readOnly` label; it cannot inspect what a tool
 * does. The tab is therefore the authority on labels and on enforcement:
 * while `welcome.readOnlyCeiling` is true, or the effective `permission` is
 * `read-only`, the tab MUST itself refuse every call to a tool that changes
 * the model, whatever label it sent, and answer it with an `isError` result.
 * The bridge's own filtering is a second line, not the guarantee.
 *
 * Everything the tab sends (tool names, titles, descriptions, schemas,
 * results) reaches the agent as data from the viewer and the model, never as
 * instructions; the bridge says so in its MCP `instructions`.
 */

import { checkJsonBounds, checkSchemaShape, utf8Length } from './json-bounds.js';
import { clip, quoted } from './sanitize.js';

/** Bumped on any incompatible change. The bridge rejects any other value. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Loopback WebSocket transport: the port `--bridge` listens on unless `--bridge-port` says otherwise. */
export const DEFAULT_BRIDGE_PORT = 21517;

/** The viewer the pairing link points at unless `--bridge-viewer-url` says otherwise. */
export const DEFAULT_BRIDGE_VIEWER_URL = 'https://ifclite.com';

/** The bridge-owned tool, always listed. A tab may not register a tool with this name. */
export const BRIDGE_STATUS_TOOL = 'bridge_status';

/** Key in the pairing link's URL fragment that marks it as a bridge pairing link. */
export const PAIRING_FRAGMENT_KEY = 'mcp-bridge';

/**
 * Bridge-side limits the tab must stay within. A hello or update over a limit
 * is refused (a hello fatally, an update with a non-fatal `error` frame); a
 * result over a limit fails its call with an `isError` result naming the limit.
 */
export const BRIDGE_LIMITS = {
  /** Largest inbound frame on a paired session, in bytes. A bigger frame closes the channel (WebSocket close 1009). */
  maxMessageBytes: 16 * 1024 * 1024,
  /**
   * Inbound bytes allowed on a channel BEFORE it is paired (the hello and
   * nothing else): enough for `maxDescriptorBytes` plus slack. More, and the
   * channel is dropped before anything is parsed.
   */
  maxUnpairedBytes: 1024 * 1024 + 256 * 1024,
  /** Nesting depth of a whole frame, checked before any field is read. */
  maxFrameDepth: 72,
  /** JSON values in a whole frame, checked before any field is read. */
  maxFrameNodes: 300_000,
  /** Length of `id`, `sessionId` and `pairingCode` strings. */
  maxIdLength: 64,
  /** Length of `type` strings. */
  maxTypeLength: 16,
  maxTools: 256,
  maxToolNameLength: 64,
  maxDescriptionLength: 8192,
  maxTitleLength: 256,
  /** UTF-8 bytes of all tool descriptors together (as JSON), schemas included. */
  maxDescriptorBytes: 1024 * 1024,
  /** Nesting depth of one tool's `inputSchema` (the schema object itself is level 1). */
  maxSchemaDepth: 32,
  /** JSON values (objects, arrays, scalars) in one tool's `inputSchema`. */
  maxSchemaNodes: 5000,
  /** UTF-8 bytes of one `result` value, as JSON. */
  maxResultBytes: 4 * 1024 * 1024,
  /** Nesting depth of one `result` value (the result object is level 1). */
  maxResultDepth: 64,
  /** JSON values in one `result` value. */
  maxResultNodes: 250_000,
} as const;

/**
 * What the user granted in the tab. `read-only` is the default. The bridge may
 * lower it (`--read-only` is a ceiling) but never raises it.
 */
export type BridgePermission = 'read-only' | 'read-write';

export interface BridgeToolDescriptor {
  /** MCP tool name: letters, digits, `_`, `-`, `.`; at most 64 characters. */
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. Must be an object schema. */
  inputSchema: Record<string, unknown>;
  /** Human-readable name, listed as the MCP tool `title` when present. */
  title?: string;
  /**
   * False when the tool changes the model. Required, so a tab cannot leave a
   * mutating tool unmarked by omission. Tools labelled `readOnly: false` are
   * neither listed nor forwarded while the effective permission is
   * `read-only`. Listed over MCP as `annotations.readOnlyHint`. The label is
   * the tab's claim: see the read-only obligation in the module header.
   */
  readOnly: boolean;
}

/** Content the bridge accepts in a result: text only. Other MCP content types (image, resource) are refused. */
export interface BridgeTextContent {
  type: 'text';
  text: string;
}

/** MCP `CallToolResult`, as the tab returns it. Passed through unchanged once valid. */
export interface BridgeCallResult {
  content: BridgeTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// ── tab -> bridge ────────────────────────────────────────────────────────

export interface BridgeHelloMessage {
  type: 'hello';
  protocol: number;
  /** The one-time code the bridge printed. Case and `-`/space separators are ignored. */
  pairingCode: string;
  permission: BridgePermission;
  tools: BridgeToolDescriptor[];
  client?: { name: string; version?: string };
}

export interface BridgeResultMessage {
  type: 'result';
  sessionId: string;
  /** The `id` of the `call` being answered. */
  id: string;
  result: BridgeCallResult;
}

export interface BridgeUpdateMessage {
  type: 'update';
  sessionId: string;
  permission?: BridgePermission;
  tools?: BridgeToolDescriptor[];
}

export type BridgeTabMessage = BridgeHelloMessage | BridgeResultMessage | BridgeUpdateMessage;

// ── bridge -> tab ────────────────────────────────────────────────────────

export interface BridgeWelcomeMessage {
  type: 'welcome';
  protocol: number;
  sessionId: string;
  /** Effective permission: the tab's grant, capped by the bridge's ceiling. */
  permission: BridgePermission;
  /**
   * True when the bridge was started `--read-only`. The tab MUST then refuse
   * every model-changing call itself (see the read-only obligation above).
   */
  readOnlyCeiling: boolean;
  bridge: { name: string; version: string };
}

export interface BridgeCallMessage {
  type: 'call';
  sessionId: string;
  /** Unique across the bridge process's lifetime, never reused. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface BridgeCancelMessage {
  type: 'cancel';
  sessionId: string;
  id: string;
  reason: 'cancelled' | 'timeout';
}

export interface BridgeErrorMessage {
  type: 'error';
  code: BridgeErrorCode;
  message: string;
}

export type BridgeServerMessage =
  | BridgeWelcomeMessage
  | BridgeCallMessage
  | BridgeCancelMessage
  | BridgeErrorMessage;

/** Codes in `error` frames. Fatal ones end the channel (on the WebSocket transport: a close with the matching {@link BridgeCloseCode}). */
export const BridgeErrorCode = {
  PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH',
  PAIRING_FAILED: 'PAIRING_FAILED',
  HANDSHAKE_TIMEOUT: 'HANDSHAKE_TIMEOUT',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  REPLACED: 'REPLACED',
  BUSY: 'BUSY',
  SHUTTING_DOWN: 'SHUTTING_DOWN',
} as const;
export type BridgeErrorCode = typeof BridgeErrorCode[keyof typeof BridgeErrorCode];

/** Loopback WebSocket transport: the close code for each fatal error (application range 4000-4999). */
export const BridgeCloseCode = {
  INVALID_MESSAGE: 4400,
  PAIRING_FAILED: 4401,
  HANDSHAKE_TIMEOUT: 4408,
  REPLACED: 4409,
  PROTOCOL_VERSION_MISMATCH: 4426,
  BUSY: 4429,
  SHUTTING_DOWN: 4503,
} as const;

// ── validation ───────────────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const TOOL_NAME = /^[A-Za-z0-9_.-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPermission(v: unknown): v is BridgePermission {
  return v === 'read-only' || v === 'read-write';
}

/** Check a tab's tool list. Rejects the whole list on the first bad entry. */
export function validateToolDescriptors(raw: unknown): ParseResult<BridgeToolDescriptor[]> {
  if (!Array.isArray(raw)) return { ok: false, error: 'tools must be an array' };
  if (raw.length > BRIDGE_LIMITS.maxTools) {
    return { ok: false, error: `at most ${BRIDGE_LIMITS.maxTools} tools; got ${raw.length}` };
  }
  const seen = new Set<string>();
  const tools: BridgeToolDescriptor[] = [];
  for (const [i, t] of raw.entries()) {
    if (!isRecord(t)) return { ok: false, error: `tools[${i}] must be an object` };
    const { name, title, description, inputSchema, readOnly } = t;
    if (typeof name !== 'string' || name.length === 0 || name.length > BRIDGE_LIMITS.maxToolNameLength || !TOOL_NAME.test(name)) {
      return { ok: false, error: `tools[${i}].name must match ${TOOL_NAME} and be 1-${BRIDGE_LIMITS.maxToolNameLength} characters` };
    }
    if (name === BRIDGE_STATUS_TOOL) return { ok: false, error: `tools[${i}].name '${BRIDGE_STATUS_TOOL}' is reserved for the bridge` };
    if (seen.has(name)) return { ok: false, error: `tools[${i}].name '${name}' is listed twice` };
    seen.add(name);
    if (typeof description !== 'string' || description.length > BRIDGE_LIMITS.maxDescriptionLength) {
      return { ok: false, error: `tools[${i}].description must be a string of at most ${BRIDGE_LIMITS.maxDescriptionLength} characters` };
    }
    if (!isRecord(inputSchema) || inputSchema.type !== 'object') {
      return { ok: false, error: `tools[${i}].inputSchema must be a JSON Schema object with type 'object'` };
    }
    const schemaError = checkJsonBounds(inputSchema, { maxDepth: BRIDGE_LIMITS.maxSchemaDepth, maxNodes: BRIDGE_LIMITS.maxSchemaNodes }, `tools[${i}].inputSchema`)
      ?? checkSchemaShape(inputSchema, `tools[${i}].inputSchema`);
    if (schemaError) return { ok: false, error: schemaError };
    if (typeof readOnly !== 'boolean') return { ok: false, error: `tools[${i}].readOnly must be a boolean` };
    if (title !== undefined && (typeof title !== 'string' || title.length > BRIDGE_LIMITS.maxTitleLength)) {
      return { ok: false, error: `tools[${i}].title must be a string of at most ${BRIDGE_LIMITS.maxTitleLength} characters` };
    }
    tools.push({ name, ...(title !== undefined ? { title } : {}), description, inputSchema, readOnly });
  }
  const bytes = utf8Length(JSON.stringify(tools));
  if (bytes > BRIDGE_LIMITS.maxDescriptorBytes) {
    return { ok: false, error: `tool descriptors total ${bytes} bytes; the limit is ${BRIDGE_LIMITS.maxDescriptorBytes}` };
  }
  return { ok: true, value: tools };
}

function validateCallResult(raw: unknown): ParseResult<BridgeCallResult> {
  if (!isRecord(raw)) return { ok: false, error: 'result must be an object' };
  const bounds = checkJsonBounds(raw, { maxDepth: BRIDGE_LIMITS.maxResultDepth, maxNodes: BRIDGE_LIMITS.maxResultNodes }, 'result');
  if (bounds) return { ok: false, error: bounds };
  if (!Array.isArray(raw.content)) return { ok: false, error: 'result.content must be an array' };
  for (const [i, c] of raw.content.entries()) {
    if (!isRecord(c) || c.type !== 'text' || typeof c.text !== 'string') {
      return { ok: false, error: `result.content[${i}] must be {type: 'text', text: string}; the bridge accepts text content only` };
    }
  }
  if (raw.structuredContent !== undefined && !isRecord(raw.structuredContent)) {
    return { ok: false, error: 'result.structuredContent must be an object' };
  }
  if (raw.isError !== undefined && typeof raw.isError !== 'boolean') {
    return { ok: false, error: 'result.isError must be a boolean' };
  }
  const value: BridgeCallResult = {
    content: (raw.content as Array<{ text: string }>).map((c) => ({ type: 'text', text: c.text })),
    ...(raw.structuredContent !== undefined ? { structuredContent: raw.structuredContent as Record<string, unknown> } : {}),
    ...(raw.isError !== undefined ? { isError: raw.isError } : {}),
  };
  const bytes = utf8Length(JSON.stringify(value));
  if (bytes > BRIDGE_LIMITS.maxResultBytes) {
    return { ok: false, error: `result is ${bytes} bytes; the limit is ${BRIDGE_LIMITS.maxResultBytes}` };
  }
  return { ok: true, value };
}

/**
 * Parse and check one frame from the tab. The protocol version is checked by
 * the caller, so that a mismatch can be reported as a mismatch rather than as
 * a malformed frame.
 */
export function parseTabMessage(text: string): ParseResult<BridgeTabMessage> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // The engine's message can quote the input: clip it like any tab data.
    return { ok: false, error: `not JSON: ${clip((err as Error).message, 120)}` };
  }
  // Bound the WHOLE frame before reading any field, so no later step (a
  // message, a log line, a stringify) ever touches an unbounded value.
  const frameError = checkJsonBounds(raw, { maxDepth: BRIDGE_LIMITS.maxFrameDepth, maxNodes: BRIDGE_LIMITS.maxFrameNodes }, 'frame');
  if (frameError) return { ok: false, error: frameError };
  if (!isRecord(raw)) return { ok: false, error: 'message must be a JSON object' };
  if (typeof raw.type !== 'string' || raw.type.length > BRIDGE_LIMITS.maxTypeLength) {
    return { ok: false, error: `message type must be a string of at most ${BRIDGE_LIMITS.maxTypeLength} characters; got ${quoted(raw.type, 32)}` };
  }
  for (const field of ['id', 'sessionId', 'pairingCode'] as const) {
    const v = raw[field];
    if (v !== undefined && (typeof v !== 'string' || v.length > BRIDGE_LIMITS.maxIdLength)) {
      return { ok: false, error: `${field} must be a string of at most ${BRIDGE_LIMITS.maxIdLength} characters` };
    }
  }
  switch (raw.type) {
    case 'hello': {
      if (typeof raw.protocol !== 'number') return { ok: false, error: 'hello.protocol must be a number' };
      if (typeof raw.pairingCode !== 'string') return { ok: false, error: 'hello.pairingCode must be a string' };
      if (!isPermission(raw.permission)) return { ok: false, error: "hello.permission must be 'read-only' or 'read-write'" };
      const tools = validateToolDescriptors(raw.tools);
      if (!tools.ok) return tools;
      let client: BridgeHelloMessage['client'];
      if (raw.client !== undefined) {
        if (!isRecord(raw.client) || typeof raw.client.name !== 'string') return { ok: false, error: 'hello.client.name must be a string' };
        // Shown to the agent and logged: one clipped line, never raw.
        client = { name: clip(raw.client.name, 128) };
        if (typeof raw.client.version === 'string') client.version = clip(raw.client.version, 64);
      }
      return {
        ok: true,
        value: { type: 'hello', protocol: raw.protocol, pairingCode: raw.pairingCode, permission: raw.permission, tools: tools.value, client },
      };
    }
    case 'result': {
      if (typeof raw.sessionId !== 'string') return { ok: false, error: 'result.sessionId must be a string' };
      if (typeof raw.id !== 'string') return { ok: false, error: 'result.id must be a string' };
      const result = validateCallResult(raw.result);
      if (!result.ok) return result;
      return { ok: true, value: { type: 'result', sessionId: raw.sessionId, id: raw.id, result: result.value } };
    }
    case 'update': {
      if (typeof raw.sessionId !== 'string') return { ok: false, error: 'update.sessionId must be a string' };
      const msg: BridgeUpdateMessage = { type: 'update', sessionId: raw.sessionId };
      if (raw.permission !== undefined) {
        if (!isPermission(raw.permission)) return { ok: false, error: "update.permission must be 'read-only' or 'read-write'" };
        msg.permission = raw.permission;
      }
      if (raw.tools !== undefined) {
        const tools = validateToolDescriptors(raw.tools);
        if (!tools.ok) return tools;
        msg.tools = tools.value;
      }
      return { ok: true, value: msg };
    }
    default:
      return { ok: false, error: `unknown message type ${quoted(raw.type, 32)}` };
  }
}
