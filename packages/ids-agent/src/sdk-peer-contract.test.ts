/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { satisfies } from 'semver';
import { describe, expect, it } from 'vitest';

interface PackageMetadata {
  version: string;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}
const metadata = (url: URL): PackageMetadata => JSON.parse(readFileSync(url, 'utf8'));
const agent = metadata(new URL('../package.json', import.meta.url));
const viewer = metadata(new URL('../../../apps/viewer/package.json', import.meta.url));
const sdk = metadata(new URL('./package.json', import.meta.resolve('@anthropic-ai/sdk')));

// #8610: these manifests are the installer's compatibility contract, not source
// wiring. The actual SDK streaming behavior is exercised by providers/anthropic.test.ts.
describe('published Anthropic SDK compatibility contract (#8610)', () => {
  it('accepts the SDK that executes the agent and viewer streaming tests', () => {
    const peer = agent.peerDependencies?.['@anthropic-ai/sdk'];
    const development = agent.devDependencies?.['@anthropic-ai/sdk'];
    const application = viewer.dependencies?.['@anthropic-ai/sdk'];
    expect(peer).toBeTypeOf('string');
    expect(development).toBeTypeOf('string');
    expect(application).toBeTypeOf('string');
    expect(satisfies(sdk.version, peer!)).toBe(true);
    expect(satisfies(sdk.version, development!)).toBe(true);
    expect(satisfies(sdk.version, application!)).toBe(true);
  });

  it.each(['0.128.0', '0.132.1', '1.5.9', '2.0.0'])('does not advertise unsupported SDK %s', version => {
    expect(satisfies(version, agent.peerDependencies!['@anthropic-ai/sdk'])).toBe(false);
  });

  it.each(['1.6.0', '1.6.1', '1.99.0'])('allows compatible SDK %s', version => {
    expect(satisfies(version, agent.peerDependencies!['@anthropic-ai/sdk'])).toBe(true);
  });
});
