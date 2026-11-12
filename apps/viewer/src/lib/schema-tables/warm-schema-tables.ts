/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Decode, while the page is idle after a load has settled, the schema tables
 * a user's first interaction reads.
 *
 * The generated schema tables are compact strings decoded on first use, so
 * the viewer no longer pays for them at boot. That moves the cost to the
 * first interaction that reads them. Measured (untimed; Chrome, fresh realm,
 * 4x CPU throttling, medians): first property edit 24 ms, bulk attribute
 * write 43 ms, metadata-edit attribute lookup 39 ms, first export 56 ms,
 * schema-aware filter 51 ms. After these steps the same first calls cost
 * 0.1-7.5 ms. The steps themselves total about 58 ms at 4x, so each runs in
 * its own idle slice.
 *
 * Gating, as for the other after-load work (`hooks/sceneSnapshotWrite.ts`
 * `whenLoadInteractive`): nothing runs while a load or geometry stream is in
 * progress, and nothing runs before a model is loaded, so it never competes
 * with first paint or a load. A load that starts mid-warm pauses it; the
 * remaining steps run after that load settles. Each schema version is warmed
 * once per page. An interaction that comes first simply decodes what it
 * needs itself, as it would without this module.
 */

import { getInheritanceChainAcrossSchemas, getSchemaRegistryForVersion, normalizeIfcTypeName } from '@ifc-lite/parser';
import { getAttributeXsdTypes } from '@ifc-lite/data';
import { useViewerStore } from '@/store';

/** The registry family a loaded model's `schemaVersion` reads. */
type RegistryFamily = 'IFC2X3' | 'IFC4' | 'IFC4X3';

function registryFamily(schemaVersion: string | undefined): RegistryFamily {
  if (schemaVersion === 'IFC2X3') return 'IFC2X3';
  if (schemaVersion === 'IFC4X3' || schemaVersion === 'IFC5') return 'IFC4X3';
  return 'IFC4';
}

export interface WarmStep {
  readonly name: string;
  readonly run: () => void;
}

/**
 * The decodes a model's first interactions need, cheapest-to-skip last:
 * the cross-schema entity union (property edits, bulk writes, filters and
 * export all read it), the IFC4 pin (attribute names, export's defined
 * types), the model's own registry when it is not IFC4, and its schema's
 * attribute XSD index (metadata edits).
 */
export function schemaTableWarmSteps(schemaVersion: string | undefined): WarmStep[] {
  const family = registryFamily(schemaVersion);
  const steps: WarmStep[] = [
    { name: 'entity-union', run: () => { getInheritanceChainAcrossSchemas('IfcWall'); } },
    { name: 'type-names', run: () => { normalizeIfcTypeName('IFCWALL'); } },
    { name: 'registry-IFC4', run: () => { getSchemaRegistryForVersion('IFC4'); } },
  ];
  if (family !== 'IFC4') steps.push({ name: `registry-${family}`, run: () => { getSchemaRegistryForVersion(family); } });
  steps.push({ name: `attribute-xsd-${family}`, run: () => { getAttributeXsdTypes(family, 'IFCWALL', 'Name'); } });
  return steps;
}

/** What the warm step reads from the page; injectable for tests. */
export interface WarmEnv {
  /** A model is loaded and no load or geometry stream is in progress. */
  settled(): boolean;
  /** The loaded model's schema version, when there is one. */
  schemaVersion(): string | undefined;
  /** Calls `listener` on every state change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Resolves in the next idle period. */
  idle(): Promise<void>;
  /** The steps for a schema version. */
  steps?(schemaVersion: string | undefined): WarmStep[];
}

const IDLE_TIMEOUT_MS = 2_000;

function viewerEnv(): WarmEnv {
  return {
    settled: () => {
      const { loading, geometryStreamingActive, models, ifcDataStore } = useViewerStore.getState();
      return !loading && !geometryStreamingActive && (models.size > 0 || ifcDataStore != null);
    },
    schemaVersion: () => {
      const { models, activeModelId, ifcDataStore } = useViewerStore.getState();
      const active = activeModelId ? models.get(activeModelId) : undefined;
      return (active?.ifcDataStore ?? ifcDataStore ?? [...models.values()][0]?.ifcDataStore)?.schemaVersion;
    },
    subscribe: (listener) => useViewerStore.subscribe(listener),
    idle: () => new Promise((resolve) => {
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS });
      } else setTimeout(resolve, 50);
    }),
  };
}

/**
 * Start watching for settled loads and warm each new schema version at idle.
 * Returns a stop function. Safe to call once at startup: it does nothing
 * until a model has loaded and settled.
 */
export function startSchemaTableWarm(env: WarmEnv = viewerEnv()): () => void {
  const warmed = new Set<RegistryFamily>();
  let running = false;
  let stopped = false;

  const pump = async (): Promise<void> => {
    if (running || stopped || !env.settled()) return;
    const version = env.schemaVersion();
    const family = registryFamily(version);
    if (version === undefined || warmed.has(family)) return;
    running = true;
    try {
      const steps = (env.steps ?? schemaTableWarmSteps)(version);
      for (const step of steps) {
        await env.idle();
        // A load that started meanwhile owns the main thread: stop here and
        // let the next settled state run the whole (idempotent) list again.
        if (stopped || !env.settled()) return;
        try {
          step.run();
        } catch (error) {
          console.warn(`[schema-table warm] ${step.name} skipped:`, error);
        }
      }
      warmed.add(family);
    } finally {
      running = false;
    }
  };

  const unsubscribe = env.subscribe(() => { void pump(); });
  void pump();
  return () => { stopped = true; unsubscribe(); };
}
