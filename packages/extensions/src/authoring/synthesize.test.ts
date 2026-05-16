/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { extractBundlePieces, parseBundleOutput } from './synthesize.js';

const VALID_RESPONSE = `Here's the bundle:

\`\`\`ifc-extension-manifest
{
  "manifestVersion": 1,
  "id": "com.example.demo",
  "name": "Demo",
  "description": "A demo.",
  "version": "1.0.0",
  "engines": { "ifcLiteSdk": ">=2.0.0" },
  "capabilities": ["model.read"],
  "activation": ["onCommand:ext.demo.run"],
  "contributes": { "commands": [{ "id": "ext.demo.run", "title": "Demo" }] },
  "entry": { "commands": { "ext.demo.run": "src/commands/run.js" } }
}
\`\`\`

\`\`\`ifc-extension-code path="src/commands/run.js"
async function run(ctx) {
  return ctx.bim.query.byType('IfcWall');
}
\`\`\`
`;

describe('extractBundlePieces', () => {
  it('extracts each fenced block', () => {
    const pieces = extractBundlePieces(VALID_RESPONSE);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].kind).toBe('manifest');
    expect(pieces[1].kind).toBe('code');
    expect(pieces[1].path).toBe('src/commands/run.js');
  });

  it('returns empty array on no fenced blocks', () => {
    expect(extractBundlePieces('plain text without fences')).toEqual([]);
  });
});

describe('parseBundleOutput', () => {
  it('parses a valid response', () => {
    const r = parseBundleOutput(VALID_RESPONSE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.manifest).toBeDefined();
      expect(r.value.files['src/commands/run.js']).toContain('async function run');
    }
  });

  it('flags duplicate manifest blocks', () => {
    const dup = `${VALID_RESPONSE}\n\n\`\`\`ifc-extension-manifest\n{}\n\`\`\``;
    const r = parseBundleOutput(dup);
    expect(r.ok).toBe(false);
  });

  it('flags code blocks without a path attribute', () => {
    const malformed = `\`\`\`ifc-extension-manifest\n${JSON.stringify({})}\n\`\`\`\n\n\`\`\`ifc-extension-code\nfoo\n\`\`\``;
    const r = parseBundleOutput(malformed);
    expect(r.ok).toBe(false);
  });

  it('flags responses with code but no manifest', () => {
    const r = parseBundleOutput('```ifc-extension-code path="x.js"\nfoo\n```');
    expect(r.ok).toBe(false);
  });

  it('returns empty (no fences) cleanly', () => {
    const r = parseBundleOutput('I cannot satisfy this request.');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.manifest).toBeUndefined();
  });

  it('parses widget JSON', () => {
    const resp = `\`\`\`ifc-extension-manifest
${JSON.stringify({
  manifestVersion: 1,
  id: 'com.example.w',
  name: 'W',
  description: 'x',
  version: '1.0.0',
  engines: { ifcLiteSdk: '>=2.0.0' },
  capabilities: ['model.read'],
  activation: ['onStartup'],
  entry: {},
})}
\`\`\`

\`\`\`ifc-extension-widget path="widgets/main.json"
{ "type": "Text", "text": "hi" }
\`\`\``;
    const r = parseBundleOutput(resp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.widgets['widgets/main.json']).toEqual({ type: 'Text', text: 'hi' });
    }
  });
});
