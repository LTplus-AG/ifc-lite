/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { MessageProcessor } from '@a2ui/web_core/v1_0';
import { createIfcAgent, validateIfcMessages } from './agent.js';
import { createIfcCatalog, ifcCatalogDocument, IFC_CATALOG_COMPONENT_APIS, IFC_EXPRESS_EXAMPLES } from './catalog/index.js';
import { IFC_CATALOG_ID, IFC_FUNCTION_POLICY } from './policy.js';

describe('IFC catalog document', () => {
  it('is a v1.0 catalog under the ifc-lite id', () => {
    const doc = ifcCatalogDocument();
    expect(doc.catalogId).toBe(IFC_CATALOG_ID);
    expect(doc.protocolVersion).toBe('1.0');
  });

  it('keeps every declared property (zod/v3 interop guard)', () => {
    // A zod 4 schema mixed into A2UI's zod 3 machinery serialises to an empty
    // property bag. This is the regression the patches exist to prevent.
    const doc = ifcCatalogDocument() as { components: Record<string, { properties?: Record<string, unknown>; allOf?: unknown[] }> };
    const table = doc.components.EntityTable;
    expect(Object.keys(table.properties ?? {})).toEqual(expect.arrayContaining(['columns', 'query', 'rows', 'title', 'groupBy']));
    const query = (table.properties as Record<string, { properties?: Record<string, unknown> }>).query;
    expect(Object.keys(query.properties ?? {})).toEqual(expect.arrayContaining(['types', 'where', 'storey', 'limit']));
  });

  it('derives allowedCallers and user activation from the policy table', () => {
    const doc = ifcCatalogDocument() as { functions: Record<string, { allowedCallers?: string; requiresUserActivation?: boolean }> };
    for (const [name, policy] of Object.entries(IFC_FUNCTION_POLICY)) {
      expect(doc.functions[name].allowedCallers).toBe(policy.agentCallable ? 'rendererOrAgent' : 'rendererOnly');
      expect(Boolean(doc.functions[name].requiresUserActivation)).toBe(policy.userActivation);
    }
  });

  it('keeps the Express positional order the prompt examples rely on', () => {
    // Express maps positional arguments by property order, so inserting a property
    // early silently rebinds every positional call (a query parsed as `data`).
    const doc = ifcCatalogDocument() as { components: Record<string, { properties?: Record<string, unknown> }> };
    const leading = (name: string, n: number) => Object.keys(doc.components[name].properties ?? {}).filter((k) => k !== 'component').slice(0, n);
    expect(leading('EntityTable', 2)).toEqual(['columns', 'query']);
    expect(leading('EntityList', 2)).toEqual(['query', 'refs']);
    expect(leading('StatGroup', 1)).toEqual(['items']);
    expect(leading('GroupChart', 2)).toEqual(['groupBy', 'query']);
    expect(leading('ColorLegend', 2)).toEqual(['by', 'query']);
    expect(leading('ActionBar', 2)).toEqual(['actions', 'query']);
    expect(leading('EntityCard', 1)).toEqual(['entity']);
    expect(leading('Callout', 1)).toEqual(['text']);
  });

  it('rejects a renderer catalog that drops a component', () => {
    expect(() => createIfcCatalog({ components: IFC_CATALOG_COMPONENT_APIS.slice(1) })).toThrow(/missing \[Text\]/);
  });
});

describe('IFC agent', () => {
  it('builds an Express prompt that names the IFC components', () => {
    const agent = createIfcAgent();
    for (const name of ['EntityTable', 'StatGroup', 'GroupChart', 'ColorLegend', 'ActionBar', 'EntityCard']) {
      expect(agent.promptSnippet).toContain(`${name}(`);
    }
    expect(agent.promptSnippet).toContain('Never type counts');
  });

  it.each(IFC_EXPRESS_EXAMPLES.map((e) => [e.title, e.source]))('parses the prompt example "%s"', (_title, source) => {
    const parts = createIfcAgent().parse(`Intro.\n<a2ui>\n${source}\n</a2ui>\nOutro.`);
    expect(parts.map((p) => p.type)).toEqual(['text', 'a2ui', 'text']);
  });

  it('streams a block split across arbitrary chunks into a renderer', () => {
    const renderer = new MessageProcessor([createIfcCatalog()]);
    const stream = createIfcAgent().openStream({ renderer });
    const reply = `Here you go.\n<a2ui>\n${IFC_EXPRESS_EXAMPLES[1].source}\n</a2ui>\nDone.`;
    const parts = [];
    for (let i = 0; i < reply.length; i += 5) parts.push(...stream.feed(reply.slice(i, i + 5)));
    parts.push(...stream.close());
    expect(parts.some((p) => p.type === 'a2ui')).toBe(true);
    expect(parts.some((p) => p.type === 'error')).toBe(false);
    expect(renderer.model.surfacesMap.size).toBe(1);
  });

  it('reports an unknown component as an error part and keeps the text after it', () => {
    const stream = createIfcAgent().openStream();
    const parts = [...stream.feed('Before.\n<a2ui>\nroot = Spreadsheet("x")\n</a2ui>\nAfter.'), ...stream.close()];
    expect(parts.map((p) => p.type)).toEqual(expect.arrayContaining(['text', 'error']));
    expect(parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')).toContain('After.');
  });

  it('rejects an EntityTable column with an empty path', () => {
    const table = (path: string) => [{ version: '1.0', createSurface: { surfaceId: 't', catalogId: IFC_CATALOG_ID, components: [{ id: 'root', component: 'EntityTable', columns: [{ path }], query: { types: ['IfcWall'] } }] } }];
    expect(validateIfcMessages(table('Name'))).toEqual([]);
    expect(validateIfcMessages(table(''))).not.toEqual([]);
  });

  it('validates hand-written payloads', () => {
    expect(validateIfcMessages([{ version: '1.0', createSurface: { surfaceId: 'x', catalogId: IFC_CATALOG_ID, components: [{ id: 'root', component: 'Nope' }] } }]).join(' ')).toContain("Unknown component type 'Nope'");
  });
});
