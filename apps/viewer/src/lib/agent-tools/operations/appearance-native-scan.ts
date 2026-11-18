/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { operation, viewerOperation, emptySchema, pointSchema } from './contract';
import { assertToolActive } from '../cancellation';
import { nativeScanState, nativeScanStates, releaseNativeScanTransfer } from './appearance-native-scan-context';
const outputSchema = {
  type: 'object',
  properties: { native_json: { type: 'string' } },
  required: ['native_json'],
  additionalProperties: false,
};
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
const meta = (id: string, description: string, write = false) => ({
  id,
  owner: 'appearance',
  description,
  effects: write ? (['configuration'] as const) : (['read'] as const),
  capability: write ? ('commands-and-edits' as const) : ('read' as const),
  implementation: 'native-store' as const,
  outputSchema,
});
const tokenInput = {
  type: 'object' as const,
  properties: {
    token: { type: 'string' as const, minLength: 1, maxLength: 100 },
    version: { type: 'integer' as const, minimum: 0 },
  },
  required: ['token' as const, 'version' as const],
  additionalProperties: false as const,
};
export const appearanceScanOperations = [
  viewerOperation(
    meta(
      'appearance.scan.sources',
      'Inspect the same native textured-GLB/retained RGB point-cloud sources and IFC destination models as Appearance Scan. Source models still load through the canonical Sources workflow.',
    ),
    emptySchema,
    async (_, c) => {
      const { nativeAppearanceScanSources } = await import('@/lib/appearance/appearance-native-scan-sources');
      assertToolActive(c);
      const s = useViewerStore.getState();
      return out({
        sources: nativeAppearanceScanSources(s.models),
        targets: [...s.models.values()]
          .filter((model) => model.ifcDataStore && !/\.glb$/i.test(model.sourceFile?.name ?? ''))
          .map((model) => ({ model_id: model.id, name: model.name })),
        repositioning: !!s.modelPlacement.preview,
        shared_room: !!s.collabRoomId,
      });
    },
  ),
  operation<{ source_model_id: string; source_kind: 'mesh' | 'points'; mesh_ordinal: number }>(
    meta(
      'appearance.scan.prepare',
      'Prepare the actual immutable native scan/IFC registration session, including source/target hashes, materialized pending edits, stable workspace frame, concrete geometry/point-sample and session staleness guards. Chooses native source kind explicitly; no alternate ingest or registration implementation.',
    ),
    {
      type: 'object',
      properties: {
        source_model_id: { type: 'string', minLength: 1, maxLength: 200 },
        source_kind: { type: 'string', enum: ['mesh', 'points'] },
        mesh_ordinal: { type: 'integer', minimum: 0, maximum: 10000000 },
      },
      required: ['source_model_id', 'source_kind', 'mesh_ordinal'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { prepareScanSession } = await import('@/lib/appearance/scan/session');
      assertToolActive(c);
      if (!c.signal) throw new Error('A live cancellation signal is required.');
      if (nativeScanStates(c).size >= 8) throw new Error('Native scan session capacity reached.');
      const session = await prepareScanSession(
        i.source_model_id,
        i.source_kind === 'points' ? 'points' : i.mesh_ordinal,
        c.model.id,
        c.signal,
      );
      assertToolActive(c);
      session.validate();
      if (nativeScanStates(c).size >= 8) throw new Error('Native scan session capacity reached.');
      const token = crypto.randomUUID();
      nativeScanStates(c).set(token, { session, pairs: [], version: 0 });
      return out({
        token,
        version: 0,
        source_frame: session.sourceFrame,
        target_frame: session.targetFrame,
        source_kind: session.source.kind,
        source_population:
          session.source.kind === 'mesh'
            ? { triangles: session.source.mesh.indices.length / 3, vertices: session.source.mesh.positions.length / 3 }
            : { points: session.source.points.count },
      });
    },
  ),
  operation<{ token: string; version: number }>(
    meta(
      'appearance.scan.inspect',
      'Inspect exact native landmark correspondences, fit/check partitions, registration residuals and recovery state. Stale diagnostics remain visible without inventing a successful registration.',
    ),
    tokenInput,
    (i, c) => {
      const state = nativeScanState(c, i.token, i.version, false);
      let stale: string | null = null;
      try {
        state.session.validate();
      } catch (error) {
        stale = error instanceof Error ? error.message : String(error);
      }
      return out({
        token: i.token,
        version: state.version,
        pairs: state.pairs,
        pending: state.pending,
        result: state.result ?? null,
        stale,
        can_revalidate: !!state.recovery,
        transfer: state.transfer
          ? {
              original: state.transfer.stage.preview === null,
              coverage: state.transfer.output.transfer,
              applied: !!state.transfer.applied,
            }
          : null,
      });
    },
  ),
  operation<{
    token: string;
    version: number;
    partition: 'fit' | 'check';
    index: number;
    weights: [number, number, number];
  }>(
    meta(
      'appearance.scan.sourceLandmark',
      'Choose an exact native source landmark: a retained point index or mesh triangle ordinal plus barycentric weights [A,B,C]. Uses pointLandmark/sourceLandmark and their stable native observation identities; the next target pick consumes this pending source.',
      true,
    ),
    {
      type: 'object',
      properties: {
        ...tokenInput.properties,
        partition: { type: 'string', enum: ['fit', 'check'] },
        index: { type: 'integer', minimum: 0, maximum: 1000000000 },
        weights: pointSchema,
      },
      required: ['token', 'version', 'partition', 'index', 'weights'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [{ sourceLandmark }, { pointLandmark }] = await Promise.all([
        import('@/lib/appearance/scan/landmarks'),
        import('@/lib/appearance/scan/point-source'),
      ]);
      assertToolActive(c);
      const state = nativeScanState(c, i.token, i.version),
        source = state.session.source;
      const point =
        source.kind === 'points'
          ? pointLandmark(source.points, i.index)
          : sourceLandmark(
              source.mesh,
              { triangleIndex: i.index, barycentricCoord: { w: i.weights[0], u: i.weights[1], v: i.weights[2] } },
              source.meshOrdinal,
            );
      return c.commit(() => {
        state.pending = { point, partition: i.partition };
        state.version++;
        return out({ pending: state.pending, version: state.version });
      });
    },
  ),
  operation<{ token: string; version: number; viewport_x: number; viewport_y: number }>(
    meta(
      'appearance.scan.targetLandmark',
      'Pick a visible concrete IFC target surface at native viewport CSS coordinates, consuming the exact pending source landmark. Uses native raycaster/feature IDs, clipping/capture guards, duplicate-point limits and target-mesh retention; no fabricated free-space correspondences.',
      true,
    ),
    {
      type: 'object',
      properties: {
        ...tokenInput.properties,
        viewport_x: { type: 'number', minimum: 0, maximum: 10000000 },
        viewport_y: { type: 'number', minimum: 0, maximum: 10000000 },
      },
      required: ['token', 'version', 'viewport_x', 'viewport_y'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [{ targetLandmark }, { appendNativeScanPair }] = await Promise.all([
        import('@/lib/appearance/scan/landmarks'),
        import('@/lib/appearance/appearance-native-scan'),
      ]);
      assertToolActive(c);
      const state = nativeScanState(c, i.token, i.version),
        renderer = getGlobalRenderer(),
        pending = state.pending;
      if (!pending || !renderer) throw new Error('Choose a pending source landmark and mount the native viewport.');
      const rect = renderer.getCanvas().getBoundingClientRect();
      if (i.viewport_x > rect.width || i.viewport_y > rect.height)
        throw new Error('Choose a point inside the current viewport.');
      const target = targetLandmark(state.session, renderer, i.viewport_x, i.viewport_y);
      if (!target) throw new Error('Native target picking is currently unavailable.');
      return c.commit(() => {
        const pairs = appendNativeScanPair(state.pairs, pending, target);
        releaseNativeScanTransfer(state);
        state.pairs = pairs;
        state.pending = undefined;
        state.result = undefined;
        state.recovery = undefined;
        state.version++;
        return out({ pair: state.pairs.at(-1), version: state.version });
      });
    },
  ),
  operation<{ token: string; version: number }>(
    meta(
      'appearance.scan.calculate',
      'Run the same native Rust registerScan service over current fit/check correspondences and immutable frames. Returns actual fit/held-out residuals and degeneracy diagnostics; forwards worker cancellation and revalidates native session after completion.',
      true,
    ),
    tokenInput,
    async (i, c) => {
      const [{ registerNativeScanSession }, { createAppearancePlanner }] = await Promise.all([
        import('@/lib/appearance/appearance-native-scan'),
        import('@/lib/appearance/planner-worker-client'),
      ]);
      const state = nativeScanState(c, i.token, i.version);
      if (!c.signal) throw new Error('A live cancellation signal is required.');
      const planner = createAppearancePlanner();
      try {
        const result = await registerNativeScanSession(state.session, state.pairs, planner, c.signal);
        assertToolActive(c);
        return c.commit(() => {
          nativeScanState(c, i.token, i.version);
          releaseNativeScanTransfer(state);
          state.result = result;
          state.recovery = undefined;
          state.pending = undefined;
          state.version++;
          return out({ result, version: state.version });
        });
      } finally {
        planner.dispose();
      }
    },
  ),
  operation<{
    token: string;
    version: number;
    action: 'removePair' | 'clearPairs' | 'discard' | 'changePartition' | 'cancelPending';
    partition: 'fit' | 'check';
    pair_id: string;
  }>(
    meta(
      'appearance.scan.edit',
      'Remove an exact native pair, clear landmarks/registration, or discard the host-owned scan session and transfer preview. Explicit scan preparation restarts from a new native binding.',
      true,
    ),
    {
      type: 'object',
      properties: {
        ...tokenInput.properties,
        action: { type: 'string', enum: ['removePair', 'clearPairs', 'discard', 'changePartition', 'cancelPending'] },
        pair_id: { type: 'string', maxLength: 200 },
        partition: { type: 'string', enum: ['fit', 'check'] },
      },
      required: ['token', 'version', 'action', 'pair_id', 'partition'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { changeNativeScanPartition } = await import('@/lib/appearance/appearance-native-scan');
      return c.commit(() => {
        const state = nativeScanState(c, i.token, i.version, false);
        if (state.transfer?.applying) throw new Error('The native transfer is being applied.');
        if (i.action === 'cancelPending') {
          state.pending = undefined;
          state.version++;
          return out({ version: state.version });
        }
        if (i.action === 'discard') {
          releaseNativeScanTransfer(state);
          nativeScanStates(c).delete(i.token);
          return out({ discarded: true });
        }
        if (
          (i.action === 'removePair' || i.action === 'changePartition') &&
          !state.pairs.some((pair) => pair.correspondence.id === i.pair_id)
        )
          throw new Error('Unknown native correspondence.');
        const pairs =
          i.action === 'clearPairs'
            ? []
            : i.action === 'changePartition'
              ? changeNativeScanPartition(state.pairs, i.pair_id, i.partition)
              : state.pairs.filter((pair) => pair.correspondence.id !== i.pair_id);
        releaseNativeScanTransfer(state);
        state.pairs = pairs;
        state.result = undefined;
        state.recovery = undefined;
        state.pending = undefined;
        state.version++;
        return out({ version: state.version, pairs: state.pairs });
      });
    },
  ),
];
