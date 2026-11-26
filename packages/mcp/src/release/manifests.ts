/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two listings of this server, built from its package.json so their
 * versions cannot drift from the npm release:
 *
 * - `server.json` for the MCP Registry, schema 2025-12-11
 *   (static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json).
 * - `manifest.json` for an MCP Bundle (.mcpb), manifest_version 0.3
 *   (github.com/modelcontextprotocol/mcpb, MANIFEST.md), for Claude Desktop.
 *
 * `release/build.mjs` writes both; nothing here touches the file system.
 */

const SERVER_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

/** The fields of @ifc-lite/mcp's package.json these listings read. */
export interface McpPackage {
  name: string;
  version: string;
  mcpName: string;
  license: string;
  author: string;
  homepage: string;
  repository: { url: string; directory: string };
  bugs: string;
  keywords: string[];
  engines: { node: string };
}

const TITLE = 'IFClite';
/** The registry caps `description` at 100 characters. */
const SUMMARY = 'Query, validate, edit and export IFC building models (BIM) from an agent.';
const GUIDE = 'https://ifclite.dev/docs/guide/mcp/';

function repoUrl(pkg: McpPackage): string {
  return pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
}

/** The MCP Registry entry: one npm package run over stdio. */
export function serverJson(pkg: McpPackage): Record<string, unknown> {
  return {
    $schema: SERVER_SCHEMA,
    name: pkg.mcpName,
    title: TITLE,
    description: SUMMARY,
    repository: { url: repoUrl(pkg), source: 'github', subfolder: pkg.repository.directory },
    websiteUrl: GUIDE,
    version: pkg.version,
    packages: [
      {
        registryType: 'npm',
        identifier: pkg.name,
        version: pkg.version,
        transport: { type: 'stdio' },
        packageArguments: [
          {
            type: 'positional',
            valueHint: 'model_path',
            description: 'IFC file to load at start. Optional and repeatable; the agent can also load models itself.',
            format: 'filepath',
            isRequired: false,
            isRepeated: true,
          },
        ],
      },
    ],
  };
}

/** Where the bundle's copy of the package sits, relative to the manifest. */
export const BUNDLE_SERVER_DIR = 'server';

/**
 * The .mcpb manifest. The bundle carries the package and its production
 * dependencies under `server/`; Claude Desktop runs it with its own Node.
 */
export function mcpbManifest(pkg: McpPackage): Record<string, unknown> {
  const entry = `${BUNDLE_SERVER_DIR}/dist/cli.js`;
  return {
    manifest_version: '0.3',
    name: 'ifc-lite',
    display_name: TITLE,
    version: pkg.version,
    description: SUMMARY,
    long_description:
      'Opens IFC2X3, IFC4, IFC4X3 and IFC5 models and gives the agent tools to query entities and properties, ' +
      'validate against IDS, run clash checks and diffs, work with BCF, edit models and export them ' +
      '(IFC, glTF, CSV, JSON, Parquet). Choose model files below, or ask the agent to load one.',
    author: { name: pkg.author },
    repository: { type: 'git', url: repoUrl(pkg) },
    homepage: pkg.homepage,
    documentation: GUIDE,
    support: pkg.bugs,
    license: pkg.license,
    keywords: pkg.keywords,
    server: {
      type: 'node',
      entry_point: entry,
      mcp_config: {
        command: 'node',
        // Each selected file becomes its own argument (MANIFEST.md, array expansion).
        // The client fills in ${user_config.models}; it is a literal here on purpose.
        // eslint-disable-next-line no-template-curly-in-string
        args: [`\${__dirname}/${entry}`, '${user_config.models}'],
      },
    },
    user_config: {
      models: {
        type: 'file',
        title: 'IFC models',
        description: 'Models to load when the server starts. Leave empty to load them from the chat instead.',
        multiple: true,
        required: false,
      },
    },
    compatibility: {
      platforms: ['darwin', 'win32', 'linux'],
      runtimes: { node: pkg.engines.node },
    },
  };
}
