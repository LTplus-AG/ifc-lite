/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared types for the /mcp landing page variants.
 *
 * The catalog shape mirrors what `node packages/mcp/dist/cli.js --dump-tools`
 * is expected to emit. Until that script lands, the landing pages can fall
 * back to `MOCK_CATALOG` from ./data.ts so we can iterate on visuals.
 */

export type ToolScope = 'read' | 'mutate' | 'export';

export type ToolCategory =
  | 'Discovery'
  | 'Query'
  | 'Geometry'
  | 'Validation'
  | 'Mutation'
  | 'BCF'
  | 'bSDD'
  | 'Diff'
  | 'Export'
  | 'Viewer';

export interface CatalogTool {
  name: string;
  description: string;
  scope: ToolScope;
  category: ToolCategory;
  inputSchema: unknown;
}

export interface McpCatalog {
  generatedAt?: string;
  version?: string;
  tools: CatalogTool[];
}

export type McpClientId = 'claude-desktop' | 'cursor' | 'windsurf' | 'vscode' | 'goose';

export interface McpClient {
  id: McpClientId;
  name: string;
  /** Short blurb shown under the button title. */
  blurb: string;
  /** Path to a logo image inside /public, or null if we render a glyph. */
  logo?: string;
  /** Optional deep-link URL scheme prefix (cursor://, windsurf://, vscode:). */
  deepLinkPrefix?: string;
  /** Where the user pastes the JSON snippet. */
  configHint: string;
}

export interface McpRecipe {
  id: string;
  title: string;
  /** The actual prompt the user copies. */
  prompt: string;
  /** Comma-separated tool names this recipe likely fans out to. */
  uses: string[];
  /** Visual category for grouping/coloring. */
  family: 'audit' | 'visualize' | 'validate' | 'author' | 'compare' | 'discover';
}
