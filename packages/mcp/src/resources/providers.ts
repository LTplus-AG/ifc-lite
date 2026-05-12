/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resource providers for the `ifc-lite://` URI scheme (spec §8).
 *
 * The set lines up with the resource patterns in the spec table. Each
 * provider knows both how to enumerate static resources (so they appear in
 * `resources/list`) and how to resolve dynamic ones via URI matching.
 */

import { EntityNode } from '@ifc-lite/query';
import { extractGeoreferencingOnDemand } from '@ifc-lite/parser';
import type { ResourceContents, ResourceDefinition } from '../protocol/index.js';
import type { ToolContext } from '../context.js';
import type { ResourceProvider } from './types.js';

const URI_PREFIX = 'ifc-lite://';

function jsonContents(uri: string, value: unknown): ResourceContents {
  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify(value, null, 2),
  };
}

class ManifestProvider implements ResourceProvider {
  name = 'manifest';
  list(ctx: ToolContext): ResourceDefinition[] {
    return ctx.registry.list().map((m) => ({
      uri: `${URI_PREFIX}model/${m.id}/manifest`,
      name: `${m.name} — manifest`,
      description: `Schema, entity counts, georef, units for model '${m.id}'.`,
      mimeType: 'application/json',
    }));
  }
  match(uri: string): boolean {
    return /^ifc-lite:\/\/model\/[^/]+\/manifest$/.test(uri);
  }
  read(uri: string, ctx: ToolContext): ResourceContents[] {
    const id = uri.replace(/^ifc-lite:\/\/model\//, '').replace(/\/manifest$/, '');
    const m = ctx.registry.get(id);
    if (!m) return [];
    const georef = extractGeoreferencingOnDemand(m.store);
    return [jsonContents(uri, {
      id: m.id,
      name: m.name,
      schema: m.store.schemaVersion,
      entityCount: m.store.entityCount,
      fileSize: m.store.fileSize,
      georeferencing: georef ?? null,
    })];
  }
}

class EntityProvider implements ResourceProvider {
  name = 'entity';
  list(): ResourceDefinition[] {
    // Entities are dynamic; expose the URL pattern as a hint via a single
    // template entry the client can show in UI but won't try to fetch.
    return [{
      uri: `${URI_PREFIX}model/{model_id}/entity/{global_id}`,
      name: 'Entity (template)',
      description: 'Read full entity data by GlobalId. Substitute {model_id} and {global_id}.',
      mimeType: 'application/json',
    }];
  }
  match(uri: string): boolean {
    return /^ifc-lite:\/\/model\/[^/]+\/entity\/[^/]+$/.test(uri);
  }
  read(uri: string, ctx: ToolContext): ResourceContents[] {
    const m = uri.match(/^ifc-lite:\/\/model\/([^/]+)\/entity\/(.+)$/);
    if (!m) return [];
    const model = ctx.registry.get(m[1]);
    if (!model) return [];
    const gid = decodeURIComponent(m[2]);
    for (const [, ids] of model.store.entityIndex.byType) {
      for (const id of ids) {
        const node = new EntityNode(model.store, id);
        if (node.globalId !== gid) continue;
        const ref = { modelId: model.id, expressId: id };
        return [jsonContents(uri, {
          ref,
          globalId: node.globalId,
          name: node.name,
          type: node.type,
          description: node.description,
          objectType: node.objectType,
          attributes: model.bim.attributes(ref),
          properties: model.bim.properties(ref),
          quantities: model.bim.quantities(ref),
          classifications: model.bim.classifications(ref),
          materials: model.bim.materials(ref),
        })];
      }
    }
    return [];
  }
}

class SpatialTreeProvider implements ResourceProvider {
  name = 'spatial-tree';
  list(ctx: ToolContext): ResourceDefinition[] {
    return ctx.registry.list().map((m) => ({
      uri: `${URI_PREFIX}model/${m.id}/spatial-tree`,
      name: `${m.name} — spatial tree`,
      mimeType: 'application/json',
    }));
  }
  match(uri: string): boolean {
    return /^ifc-lite:\/\/model\/[^/]+\/spatial-tree$/.test(uri);
  }
  read(uri: string, ctx: ToolContext): ResourceContents[] {
    const id = uri.replace(/^ifc-lite:\/\/model\//, '').replace(/\/spatial-tree$/, '');
    const m = ctx.registry.get(id);
    if (!m) return [];
    const projectIds = m.store.entityIndex.byType.get('IFCPROJECT') ?? [];
    if (projectIds.length === 0) return [jsonContents(uri, null)];
    return [jsonContents(uri, buildTreeNode(m.store, projectIds[0]))];
  }
}

interface JsonNode {
  expressId: number;
  globalId: string;
  type: string;
  name: string;
  children: JsonNode[];
}

function buildTreeNode(store: import('@ifc-lite/parser').IfcDataStore, expressId: number): JsonNode {
  const node = new EntityNode(store, expressId);
  return {
    expressId,
    globalId: node.globalId,
    type: node.type,
    name: node.name,
    children: node.decomposes().map((c) => buildTreeNode(store, c.expressId)),
  };
}

class MaterialsProvider implements ResourceProvider {
  name = 'materials';
  list(ctx: ToolContext): ResourceDefinition[] {
    return ctx.registry.list().map((m) => ({
      uri: `${URI_PREFIX}model/${m.id}/materials`,
      name: `${m.name} — materials`,
      mimeType: 'application/json',
    }));
  }
  match(uri: string): boolean {
    return /^ifc-lite:\/\/model\/[^/]+\/materials$/.test(uri);
  }
  read(uri: string, ctx: ToolContext): ResourceContents[] {
    const id = uri.replace(/^ifc-lite:\/\/model\//, '').replace(/\/materials$/, '');
    const m = ctx.registry.get(id);
    if (!m) return [];
    const counts = new Map<string, number>();
    for (const e of m.bim.query().toArray()) {
      const mat = m.bim.materials(e.ref);
      if (!mat) continue;
      const key = mat.name ?? '(unnamed)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [jsonContents(uri, {
      materials: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    })];
  }
}

class PropertySetsProvider implements ResourceProvider {
  name = 'property-sets';
  list(ctx: ToolContext): ResourceDefinition[] {
    return ctx.registry.list().map((m) => ({
      uri: `${URI_PREFIX}model/${m.id}/property-sets`,
      name: `${m.name} — property sets`,
      mimeType: 'application/json',
    }));
  }
  match(uri: string): boolean {
    return /^ifc-lite:\/\/model\/[^/]+\/property-sets$/.test(uri);
  }
  read(uri: string, ctx: ToolContext): ResourceContents[] {
    const id = uri.replace(/^ifc-lite:\/\/model\//, '').replace(/\/property-sets$/, '');
    const m = ctx.registry.get(id);
    if (!m) return [];
    const seen = new Set<string>();
    const psets: Array<{ name: string; properties: string[] }> = [];
    for (const e of m.bim.query().toArray()) {
      for (const pset of m.bim.properties(e.ref)) {
        if (seen.has(pset.name)) continue;
        seen.add(pset.name);
        psets.push({ name: pset.name, properties: pset.properties.map((p) => p.name) });
      }
    }
    return [jsonContents(uri, { propertySets: psets })];
  }
}

class ServerManifestProvider implements ResourceProvider {
  name = 'server-manifest';
  list(): ResourceDefinition[] {
    return [{
      uri: `${URI_PREFIX}server/manifest`,
      name: 'ifc-lite-mcp manifest',
      description: 'Server-wide capabilities, version, and tool catalog summary.',
      mimeType: 'application/json',
    }];
  }
  match(uri: string): boolean {
    return uri === `${URI_PREFIX}server/manifest`;
  }
  read(uri: string, ctx: ToolContext): ResourceContents[] {
    return [jsonContents(uri, {
      readOnly: ctx.config.readOnly,
      samplingEnabled: ctx.config.samplingEnabled,
      bsddEndpoint: ctx.config.bsddEndpoint ?? 'https://api.bsdd.buildingsmart.org',
      viewerOpen: ctx.viewer?.isOpen() ?? false,
      modelsLoaded: ctx.registry.list().map((m) => ({ id: m.id, name: m.name, schema: m.store.schemaVersion })),
    })];
  }
}

class ViewerSelectionProvider implements ResourceProvider {
  name = 'viewer-selection';
  list(): ResourceDefinition[] {
    return [{
      uri: `${URI_PREFIX}viewer/selection`,
      name: 'Viewer selection (live)',
      description: 'Entity the user has clicked in the 3D viewer. Subscribe to receive `notifications/resources/updated` on every pick.',
      mimeType: 'application/json',
    }];
  }
  match(uri: string): boolean {
    return uri === `${URI_PREFIX}viewer/selection` || /^ifc-lite:\/\/model\/[^/]+\/viewer\/selection$/.test(uri);
  }
  read(uri: string, ctx: ToolContext): ResourceContents[] {
    const state = ctx.viewer?.state();
    if (!state) {
      return [jsonContents(uri, { open: false, selection: [] })];
    }
    return [jsonContents(uri, {
      open: true,
      modelId: state.modelId,
      url: state.url,
      port: state.port,
      selection: state.selection,
    })];
  }
}

class ViewerStatusProvider implements ResourceProvider {
  name = 'viewer-status';
  list(): ResourceDefinition[] {
    return [{
      uri: `${URI_PREFIX}viewer/status`,
      name: 'Viewer status',
      description: 'Whether the viewer is open, on what port, and how many browser clients are connected.',
      mimeType: 'application/json',
    }];
  }
  match(uri: string): boolean {
    return uri === `${URI_PREFIX}viewer/status`;
  }
  read(uri: string, ctx: ToolContext): ResourceContents[] {
    const state = ctx.viewer?.state();
    return [jsonContents(uri, state ?? { open: false })];
  }
}

export function defaultResourceProviders(): ResourceProvider[] {
  return [
    new ServerManifestProvider(),
    new ManifestProvider(),
    new EntityProvider(),
    new SpatialTreeProvider(),
    new MaterialsProvider(),
    new PropertySetsProvider(),
    new ViewerSelectionProvider(),
    new ViewerStatusProvider(),
  ];
}
