/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  NativeMetadataEntityDetails,
  NativeMetadataEntitySummary,
  NativeMetadataSnapshot,
  NativeMetadataSpatialNode,
} from '@/store/types';
import type {
  MetadataBootstrapPayload,
  MetadataBootstrapEntitySummary,
  MetadataBootstrapSpatialNode,
} from '@ifc-lite/geometry';
import { getNativeModelSnapshot, setNativeModelSnapshot } from './desktop-cache';

function bootstrapKindToNative(kind: string): 'spatial' | 'element' {
  return kind === 'spatial' ? 'spatial' : 'element';
}

function summaryFromBootstrap(node: MetadataBootstrapEntitySummary): NativeMetadataEntitySummary {
  return {
    expressId: node.expressId,
    type: node.typeName,
    name: node.name,
    globalId: node.globalId ?? null,
    kind: bootstrapKindToNative(node.kind),
    hasChildren: node.hasChildren,
    elementCount: node.elementCount,
    elevation: node.elevation ?? null,
  };
}

function spatialNodeFromBootstrap(node: MetadataBootstrapSpatialNode | null): NativeMetadataSpatialNode | null {
  if (!node) return null;
  return {
    ...summaryFromBootstrap(node),
    children: node.children.map((c) => spatialNodeFromBootstrap(c)).filter((n): n is NativeMetadataSpatialNode => n !== null),
    elements: node.elements.map(summaryFromBootstrap),
  };
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

async function getInvoke(): Promise<InvokeFn> {
  const win = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: InvokeFn } };
  if (win.__TAURI_INTERNALS__?.invoke) {
    return win.__TAURI_INTERNALS__.invoke;
  }
  const core = await import('@tauri-apps/api/core');
  return core.invoke as InvokeFn;
}

function toSchemaVersion(schemaVersion: string): NativeMetadataSnapshot['schemaVersion'] {
  if (schemaVersion === 'IFC4X3' || schemaVersion === 'IFC4' || schemaVersion === 'IFC5') {
    return schemaVersion;
  }
  return 'IFC2X3';
}

export function nativeMetadataSnapshotFromBootstrap(
  path: string,
  payload: MetadataBootstrapPayload
): NativeMetadataSnapshot {
  return {
    mode: 'desktop-lazy',
    cacheKey: payload.cacheKey,
    filePath: path,
    schemaVersion: toSchemaVersion(payload.schemaVersion),
    entityCount: payload.entityCount,
    spatialTree: spatialNodeFromBootstrap(payload.spatialTree ?? null),
  };
}

export async function bootstrapNativeMetadata(path: string, cacheKey: string): Promise<NativeMetadataSnapshot> {
  const invoke = await getInvoke();
  // The Tauri command returns a bootstrap-shaped payload (typeName /
  // kind unfolded). Route through the shared `nativeMetadataSnapshotFromBootstrap`
  // helper so both constructors apply the same `spatialNodeFromBootstrap`
  // normalization — without this the `from cached snapshot` and
  // `bootstrap fresh` paths produce subtly different shapes and the
  // property panel reads break for the freshly-bootstrapped case.
  const result = await invoke<MetadataBootstrapPayload>('bootstrap_native_metadata', {
    path,
    cacheKey,
  });
  return nativeMetadataSnapshotFromBootstrap(path, result);
}

export async function restoreNativeMetadataSnapshot(cacheKey: string): Promise<NativeMetadataSnapshot | null> {
  const buffer = await getNativeModelSnapshot(cacheKey);
  if (!buffer) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer))) as NativeMetadataSnapshot;
    if (payload?.mode !== 'desktop-lazy' || payload.cacheKey !== cacheKey) {
      return null;
    }
    return {
      ...payload,
      schemaVersion: toSchemaVersion(payload.schemaVersion),
      spatialTree: payload.spatialTree ?? null,
    };
  } catch {
    return null;
  }
}

export async function persistNativeMetadataSnapshot(snapshot: NativeMetadataSnapshot): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  await setNativeModelSnapshot(snapshot.cacheKey, bytes.buffer);
}

export async function getNativeMetadataChildren(cacheKey: string, expressId: number): Promise<NativeMetadataEntitySummary[]> {
  const invoke = await getInvoke();
  const result = await invoke<Array<{
    expressId: number;
    typeName: string;
    name: string;
    globalId?: string | null;
    kind: 'spatial' | 'element';
    hasChildren: boolean;
    elementCount?: number;
    elevation?: number | null;
  }>>('get_native_metadata_children', {
    cacheKey,
    expressId,
  });
  return result.map((entry) => ({
    expressId: entry.expressId,
    type: entry.typeName,
    name: entry.name,
    globalId: entry.globalId ?? undefined,
    kind: entry.kind,
    hasChildren: entry.hasChildren,
    elementCount: entry.elementCount,
    elevation: entry.elevation ?? undefined,
  }));
}

export async function getNativeEntityDetails(cacheKey: string, expressId: number): Promise<NativeMetadataEntityDetails> {
  const invoke = await getInvoke();
  const result = await invoke<{
    summary: {
      expressId: number;
      typeName: string;
      name: string;
      globalId?: string | null;
      kind: 'spatial' | 'element';
      hasChildren: boolean;
      elementCount?: number;
      elevation?: number | null;
    };
    typeSummary?: {
      expressId: number;
      typeName: string;
      name: string;
      globalId?: string | null;
      kind: 'spatial' | 'element';
      hasChildren: boolean;
      elementCount?: number;
      elevation?: number | null;
    } | null;
    spatial?: {
      storeyId?: number | null;
      storeyName?: string | null;
      elevation?: number | null;
      height?: number | null;
    } | null;
    properties: NativeMetadataEntityDetails['properties'];
    quantities: NativeMetadataEntityDetails['quantities'];
  }>('get_native_entity_details', {
    cacheKey,
    expressId,
  });

  const mapSummary = (entry: NonNullable<typeof result['summary']>): NativeMetadataEntitySummary => ({
    expressId: entry.expressId,
    type: entry.typeName,
    name: entry.name,
    globalId: entry.globalId ?? undefined,
    kind: entry.kind,
    hasChildren: entry.hasChildren,
    elementCount: entry.elementCount,
    elevation: entry.elevation ?? undefined,
  });

  return {
    summary: mapSummary(result.summary),
    typeSummary: result.typeSummary ? mapSummary(result.typeSummary) : null,
    spatial: result.spatial
      ? {
          storeyId: result.spatial.storeyId ?? null,
          storeyName: result.spatial.storeyName ?? null,
          elevation: result.spatial.elevation ?? null,
          height: result.spatial.height ?? null,
        }
      : null,
    properties: result.properties,
    quantities: result.quantities,
  };
}

export async function searchNativeMetadataEntities(cacheKey: string, query: string, limit = 100): Promise<NativeMetadataEntitySummary[]> {
  const invoke = await getInvoke();
  const result = await invoke<Array<{
    expressId: number;
    typeName: string;
    name: string;
    globalId?: string | null;
    kind: 'spatial' | 'element';
    hasChildren: boolean;
    elementCount?: number;
    elevation?: number | null;
  }>>('search_native_metadata_entities', {
    cacheKey,
    query,
    limit,
  });
  return result.map((entry) => ({
    expressId: entry.expressId,
    type: entry.typeName,
    name: entry.name,
    globalId: entry.globalId ?? undefined,
    kind: entry.kind,
    hasChildren: entry.hasChildren,
    elementCount: entry.elementCount,
    elevation: entry.elevation ?? undefined,
  }));
}
