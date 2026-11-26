/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The MCP Registry `server.json` and the .mcpb manifest are built from the
 * real package.json. These pin the rules each listing is checked against at
 * publish time (registry schema 2025-12-11, mcpb manifest 0.3), so a
 * package.json edit that would get a release rejected fails here first.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { mcpbManifest, serverJson, type McpPackage } from '../src/release/manifests.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as McpPackage & {
  files: string[];
  bin: Record<string, string>;
};

describe('server.json for the MCP Registry', () => {
  const server = serverJson(pkg);
  const [npm] = server.packages as Array<Record<string, unknown>>;

  it('names the server by the package\'s mcpName, which is how the registry verifies npm ownership', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(pkg.mcpName).toMatch(/^io\.github\.[A-Za-z0-9-]+\/[a-zA-Z0-9._-]+$/);
  });

  it('carries the schema, the required fields and the npm release it lists', () => {
    expect(server.$schema).toBe('https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
    expect(server.version).toBe(pkg.version);
    expect(npm).toMatchObject({ registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } });
  });

  it('keeps the description within the registry\'s 100 characters', () => {
    expect(typeof server.description).toBe('string');
    expect((server.description as string).length).toBeLessThanOrEqual(100);
  });

  it('points the repository at the package folder, without git+ or .git', () => {
    expect(server.repository).toEqual({ url: 'https://github.com/LTplus-AG/ifc-lite', source: 'github', subfolder: 'packages/mcp' });
  });
});

describe('.mcpb manifest for Claude Desktop', () => {
  const manifest = mcpbManifest(pkg);
  const server = manifest.server as { type: string; entry_point: string; mcp_config: { command: string; args: string[] } };

  it('has every field manifest_version 0.3 requires', () => {
    expect(manifest).toMatchObject({ manifest_version: '0.3', name: 'ifc-lite', version: pkg.version });
    expect(typeof manifest.description).toBe('string');
    expect((manifest.author as { name: string }).name).toBeTruthy();
    expect(server.type).toBe('node');
  });

  it('starts the same file the package publishes as its bin', () => {
    expect(server.entry_point).toBe(`server/${pkg.bin['ifc-lite-mcp'].replace(/^\.\//, '')}`);
    expect(pkg.files).toContain('dist');
    expect(server.mcp_config.args[0]).toBe(`\${__dirname}/${server.entry_point}`);
  });

  it('passes the chosen models as arguments, and every referenced user_config key exists', () => {
    const keys = Object.keys(manifest.user_config as object);
    const used = server.mcp_config.args.flatMap((a) => [...a.matchAll(/\$\{user_config\.(\w+)\}/g)].map((m) => m[1]));
    expect(used).toEqual(['models']);
    expect(used.every((k) => keys.includes(k))).toBe(true);
  });

  it('defaults the model list to empty, so choosing none adds no argument', () => {
    expect((manifest.user_config as { models: { default: unknown } }).models.default).toEqual([]);
  });

  it('asks for the Node the package declares', () => {
    expect((manifest.compatibility as { runtimes: { node: string } }).runtimes.node).toBe(pkg.engines.node);
  });
});
