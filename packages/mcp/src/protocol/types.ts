/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model Context Protocol (MCP) wire types.
 *
 * Implements the subset of MCP 2025-11 we need. JSON-RPC 2.0 envelopes,
 * tool/resource/prompt shapes, progress notifications, and the cancellation
 * helpers. We deliberately avoid `any` and keep the types narrow so the
 * tool implementations get strong type-checking out of the box.
 */

export const PROTOCOL_VERSION = '2025-11-25';

/**
 * Published MCP revisions we negotiate. The server's wire surface
 * (initialize, tools/{list,call}, resources/*, prompts/*, notifications/*,
 * logging) is compatible across them, so we echo the requested version back
 * during initialize. Anything else gets PROTOCOL_VERSION.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
]);

export const JSONRPC_VERSION = '2.0' as const;

// ── JSON-RPC envelopes ───────────────────────────────────────────────────

export type JsonRpcId = string | number;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: P;
}

export interface JsonRpcSuccessResponse<R = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /**
   * A request other than initialize/ping before the handshake. Was -32002,
   * which the resources spec also uses for "not found"; JSON-RPC's own
   * Invalid Request says it without the clash.
   */
  ServerNotInitialized: -32600,
  /**
   * resources/read on a URI that names nothing, as clients SHOULD still accept
   * it. The server answers -32602 with `data.uri` instead (2026-07-28 makes
   * that a MUST and the SDK sends it on every revision).
   */
  ResourceNotFound: -32002,
  RequestCancelled: -32800,
} as const;

// ── Capability advertisement ─────────────────────────────────────────────

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, never>;
  experimental?: Record<string, unknown>;
}

export interface ClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: Record<string, never>;
  experimental?: Record<string, unknown>;
}

export interface InitializeParams {
  protocolVersion: string;
  capabilities: ClientCapabilities;
  clientInfo: { name: string; version: string };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: { name: string; version: string };
  instructions?: string;
}

// ── Content blocks (shared across tool / prompt results) ─────────────────

export type ContentBlock =
  | TextContent
  | ImageContent
  | ResourceLink
  | EmbeddedResource;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string; // base64
  mimeType: string;
}

/** A pointer to a resource the client may read; the content is not inlined. */
export interface ResourceLink {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

/** A resource whose contents are inlined in the message. */
export interface EmbeddedResource {
  type: 'resource';
  resource: ResourceContents;
}

export interface ResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string; // base64
}

// ── Tools ────────────────────────────────────────────────────────────────

/** MCP tool annotations: hints for clients, not guarantees. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  /** Human-readable name (MCP 2025-06-18). */
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  _meta?: ToolMeta;
}

/** `_meta` on a tool definition. Keys outside the spec carry a vendor prefix. */
export interface ToolMeta {
  ui?: { resourceUri: string; visibility?: Array<'model' | 'app'> };
  /** Which scope a token needs to call this tool. */
  'ifc-lite/scope'?: ToolScope;
}

export interface ListToolsResult {
  tools: ToolDefinition[];
  nextCursor?: string;
}

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: { progressToken?: string | number };
}

export interface CallToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type ToolScope = 'read' | 'validate' | 'mutate' | 'export' | 'admin';

// ── Resources ────────────────────────────────────────────────────────────

export interface ResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ListResourcesResult {
  resources: ResourceDefinition[];
  nextCursor?: string;
}

/** An RFC 6570 URI template for resources the client builds itself. */
export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ListResourceTemplatesResult {
  resourceTemplates: ResourceTemplate[];
  nextCursor?: string;
}

export interface ReadResourceParams { uri: string }

export interface ReadResourceResult {
  contents: ResourceContents[];
}

export interface SubscribeParams { uri: string }

// ── Prompts ──────────────────────────────────────────────────────────────

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments?: PromptArgument[];
}

export interface ListPromptsResult {
  prompts: PromptDefinition[];
}

export interface GetPromptParams {
  name: string;
  arguments?: Record<string, string>;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: ContentBlock;
}

export interface GetPromptResult {
  description?: string;
  messages: PromptMessage[];
}

// ── Notifications (server → client) ──────────────────────────────────────

export interface ProgressNotification {
  progressToken: string | number;
  progress: number;       // 0..1
  total?: number;
  message?: string;
}

export interface ResourceUpdatedNotification {
  uri: string;
}

/** RFC 5424 severities, lowest first. */
export const LOGGING_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] as const;
export type LoggingLevel = typeof LOGGING_LEVELS[number];

export interface SetLevelParams { level: LoggingLevel }

export interface LogNotification {
  level: LoggingLevel;
  logger?: string;
  data: unknown;
}

// ── JSON Schema (subset we author by hand) ───────────────────────────────

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  default?: unknown;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  anyOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}
