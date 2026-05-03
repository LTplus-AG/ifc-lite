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

export const PROTOCOL_VERSION = '2025-11-05';

/**
 * Protocol versions we are willing to negotiate. The server's wire surface
 * (initialize, tools/{list,call}, resources/*, prompts/*, notifications/*,
 * logging) has been backwards-compatible across these spec revisions, so we
 * accept any of them and echo the requested version back during initialize.
 * Unrecognized versions get downgraded to PROTOCOL_VERSION instead.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  '2025-03-26',
  '2025-06-18',
  '2025-11-05',
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
  // MCP-defined extension range starts at -32000.
  ServerNotInitialized: -32002,
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

export interface ResourceLink {
  type: 'resource';
  resource: { uri: string; mimeType?: string; text?: string };
}

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

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Optional metadata: which scope a token needs to call this tool. */
  scope?: ToolScope;
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
  role: 'user' | 'assistant' | 'system';
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

export interface LogNotification {
  level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';
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
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}
