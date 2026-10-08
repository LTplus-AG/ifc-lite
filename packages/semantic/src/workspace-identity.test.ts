/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createResourceLinkStrategy, resolveResource } from './resolver.js';
import { exportWorkspace, importWorkspace, type SemanticWorkspace } from './workspace.js';

const GlobalId = '0000000000000000000001';
const resourceId = 'https://example.org/product';
function fixture(source = 'local'): SemanticWorkspace {
  return { version: 1, datasets: [{ id: 'fixture', source, completeness: 'partial' }], queries: [],
    revisions: [{ revision: 'revision 1', modelLabel: 'Pending model' }],
    resourceLinks: [{ resourceId, modelRevision: 'revision 1', GlobalId }] };
}
describe('portable sources and revision identities (#6643 review)', () => {
  it.each(['HTTPS://user:pass@example.org/data?token=private#secret', 'ftp://user:pass@example.org/data?token=private#secret', 'custom://user:pass@example.org/data?token=private#secret'])('strips credentials from hierarchical source %s', source => {
    const serialized = exportWorkspace(fixture(source));
    expect(serialized).not.toContain('user:pass'); expect(serialized).not.toContain('private'); expect(serialized).not.toContain('secret');
    const sanitized = new URL(importWorkspace(serialized).workspace.datasets[0].source);
    expect(sanitized.username).toBe(''); expect(sanitized.password).toBe(''); expect(sanitized.search).toBe(''); expect(sanitized.hash).toBe('');
    expect(sanitized.pathname).toBe('/data');
  });
  it.each(['local fixture', 'did:example:fixture', 'urn:example:fixture'])('preserves nonhierarchical source %s', source => {
    expect(importWorkspace(exportWorkspace(fixture(source))).workspace.datasets[0].source).toBe(source);
  });
  it('round-trips an opaque revision and resolves it only after explicit reassociation', () => {
    const imported = importWorkspace(exportWorkspace(fixture()));
    const strategy = createResourceLinkStrategy(imported.workspace.resourceLinks!);
    const entities = [{ modelId: 'new-session', expressId: 100, GlobalId }];
    expect(strategy.resolve({ id: resourceId }, { entities, revisions: imported.associations }).status).toBe('unscoped');
    expect(strategy.resolve({ id: resourceId }, { entities, revisions: new Map([['revision 1', 'new-session']]) })).toEqual({ status: 'resolved', ref: { modelId: 'new-session', expressId: 100 } });
  });
  it('rejects undeclared or duplicate revisions and blank identifiers consistently', () => {
    const undeclared = fixture(); undeclared.revisions = [];
    expect(() => exportWorkspace(undeclared)).toThrow('undeclared revision');
    expect(() => importWorkspace(JSON.stringify(undeclared))).toThrow('undeclared revision');
    const duplicate = fixture(); duplicate.revisions.push({ ...duplicate.revisions[0] });
    expect(() => exportWorkspace(duplicate)).toThrow('Duplicate workspace revision');
    for (const revision of ['', '  ']) {
      const blank = fixture(); blank.revisions[0].revision = revision;
      expect(() => exportWorkspace(blank)).toThrow('non-empty');
      expect(() => createResourceLinkStrategy([{ resourceId, modelRevision: revision, GlobalId }])).toThrow('non-empty');
      expect(resolveResource({ GlobalId, modelRevision: revision }, [], new Map()).status).toBe('invalid');
    }
  });
});
