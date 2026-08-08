/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PlaygroundViewer — collapsible inline 3D viewer for /mcp/playground.
 *
 * Loads geometry from a parsed `IfcDataStore` via @ifc-lite/geometry's WASM
 * processor (`GeometryProcessor.process(buffer)`), hands it to the Three.js
 * scene in `playground-scene.ts` (one mesh per IFC entity, so each can be
 * coloured / hidden / picked individually), and exposes an imperative
 * `ViewerController` that the agent's tool dispatcher drives.
 *
 * This file owns the React half only: geometry loading, the phase HUD, and
 * forwarding the controller. The scene factory and its per-entity
 * book-keeping, colour/visibility operations and camera/section control live
 * in the `playground-scene*.ts` siblings.
 *
 * Geometry processing is async + heavy → only fired the first time the
 * panel is opened, then the result is cached.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from 'react';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import { cn } from '@/lib/utils';
import { useThreeScene } from './useThreeScene';
import { createScene } from './playground-scene';
import type { SceneHandle, ViewerController } from './playground-viewer-types';
import type { LoadedPlaygroundModel } from './playground-dispatcher';

const ACCENT = 0xd6ff3f;
const BG_COLOR = '#0e0e12';

// ── geometry loading (extracted for direct testing — see
//    PlaygroundViewer.test.ts; mounting the component pulls in
//    THREE.WebGLRenderer, which needs a real WebGL context happy-dom can't
//    provide) ──────────────────────────────────────────────────────────────

interface GeometryLoadCallbacks {
  /** Read fresh each await boundary — the caller's effect-cleanup flips this
   *  when the model changes or the component unmounts mid-flight. */
  isCancelled: () => boolean;
  setPhase: (phase: 'processing' | 'ready' | 'error') => void;
  setPhaseMsg: (msg: string) => void;
  /** Fired once with the non-empty mesh list on the success path. */
  onMeshes: (meshes: MeshData[]) => void;
  onReady?: () => void;
}

/**
 * Boots a `GeometryProcessor`, tessellates `model`, and reports the result
 * via `cb`. The processor's WASM handle is always freed before this
 * resolves — on the happy path, the `cancelled` bail-out, the empty-mesh
 * branch, and any thrown error — because the inner `try/finally` wraps every
 * one of those exits. `result.meshes` is already copied out into plain JS
 * `MeshData` (positions/indices as fresh typed arrays), so nothing
 * downstream holds onto the handle being freed.
 */
export async function loadPlaygroundGeometry(
  model: LoadedPlaygroundModel,
  cb: GeometryLoadCallbacks,
): Promise<void> {
  cb.setPhase('processing');
  cb.setPhaseMsg('booting geometry pipeline…');
  try {
    // Construction can't throw synchronously here (no wasm work happens
    // until init()), so once we're past this line `processor` is a real
    // object the finally below must dispose.
    const processor = new GeometryProcessor({ preferNative: false });
    try {
      await processor.init();
      cb.setPhaseMsg('extracting geometry…');
      // Use our owning byte snapshot — store.source can be a sub-view that
      // the parser detached internally on big files.
      const result = await processor.process(
        model.bytes,
        model.store.entityIndex.byId as unknown as Map<number, unknown>,
      );
      if (cb.isCancelled()) return;
      const meshes = result.meshes ?? [];
      // eslint-disable-next-line no-console
      console.log('[playground-viewer] geometry result:', {
        meshCount: meshes.length,
        firstMeshVerts: meshes[0]?.positions?.length,
        coordinateInfo: result.coordinateInfo,
      });
      if (meshes.length === 0) {
        cb.setPhase('error');
        cb.setPhaseMsg('No drawable geometry — model may be schema-only.');
        return;
      }
      cb.onMeshes(meshes);
      cb.setPhase('ready');
      cb.onReady?.();
    } finally {
      processor.dispose();
    }
  } catch (err) {
    if (cb.isCancelled()) return;
    // eslint-disable-next-line no-console
    console.error('[playground-viewer] geometry processing failed', err);
    cb.setPhase('error');
    cb.setPhaseMsg(err instanceof Error ? err.message : String(err));
  }
}

// ── component ──────────────────────────────────────────────────────────────

export interface PlaygroundViewerProps {
  /** Currently loaded model (or null). When this changes, the viewer reloads. */
  model: LoadedPlaygroundModel | null;
  /** Notified once geometry has been processed. */
  onReady?: () => void;
  /** Optional className to control sizing. */
  className?: string;
}

/**
 * The viewer is mounted/unmounted by the parent. Geometry processing is
 * triggered the first time `model` becomes non-null AND the parent shows
 * the panel — driven by the parent unmounting the component when the
 * panel collapses (saves GPU memory on long sessions).
 */
export const PlaygroundViewer = forwardRef<ViewerController, PlaygroundViewerProps>(function PlaygroundViewer(
  { model, onReady, className },
  ref,
) {
  // Guarded mount: a device that refuses a WebGL context must lose the canvas
  // only, not the whole /mcp/playground page (#2401). The parser, the agent
  // transcript and every non-viewer tool around us need no GPU.
  const { containerRef, handleRef: sceneHandleRef, unavailable } = useThreeScene<SceneHandle>(
    'playground',
    createScene,
  );
  const [phase, setPhase] = useState<'idle' | 'processing' | 'ready' | 'error'>('idle');
  const [phaseMsg, setPhaseMsg] = useState<string>('');
  const [meshCount, setMeshCount] = useState(0);

  useImperativeHandle(
    ref,
    (): ViewerController => ({
      isLoaded: () => sceneHandleRef.current !== null,
      status: () => ({
        loaded: sceneHandleRef.current !== null,
        meshCount,
        selection: sceneHandleRef.current?.getSelection() ?? [],
        webglUnavailable: unavailable !== null,
      }),
      colorize: (args) => sceneHandleRef.current?.colorize(args) ?? { count: 0 },
      isolate: (args) => sceneHandleRef.current?.isolate(args) ?? { count: 0 },
      hide: (args) => sceneHandleRef.current?.hide(args) ?? { count: 0 },
      show: (args) => sceneHandleRef.current?.show(args) ?? { count: 0 },
      reset: () => sceneHandleRef.current?.reset(),
      flyTo: (args) => sceneHandleRef.current?.flyTo(args) ?? { count: 0 },
      setSection: (args) => sceneHandleRef.current?.setSection(args),
      clearSection: () => sceneHandleRef.current?.clearSection(),
      colorByStorey: () => sceneHandleRef.current?.colorByStorey() ?? { groups: 0 },
      colorByProperty: (args) => sceneHandleRef.current?.colorByProperty(args) ?? { legend: [] },
      getSelection: () => sceneHandleRef.current?.getSelection() ?? [],
      setOnSelectionChange: (h) => sceneHandleRef.current?.setOnSelectionChange(h),
      subscribeSelection: (h) => sceneHandleRef.current?.subscribeSelection(h) ?? (() => undefined),
    }),
    // `unavailable` belongs here with `meshCount`: the handle is a frozen
    // closure, so leaving it out would hand the dispatcher a controller that
    // reports `webglUnavailable: false` forever — the exact loop #2412 fixes,
    // just moved one level down.
    [meshCount, unavailable],
  );

  // Load geometry whenever the model changes (and the component is mounted —
  // the parent decides when to mount us).
  useEffect(() => {
    let cancelled = false;
    // No scene to feed: tessellation is a heavy WASM pass whose only consumer
    // is the renderer we could not build, so skip it rather than burn the
    // user's CPU producing meshes nothing will ever draw (#2401).
    //
    // The REF is the signal, not the `unavailable` state. Both effects flush
    // in the same commit, in declaration order: `useThreeScene`'s runs first
    // and calls `setUnavailable`, but that is a state update — this effect
    // still sees the render's `unavailable`, which is `null` on a first visit.
    // The ref is already correct by then (the hook leaves it null when it
    // gives up), so it is the only signal available synchronously.
    //
    // Reading `unavailable` here as well would be redundant rather than
    // defensive: it is only ever set on the path that leaves the ref null, so
    // it can never be the deciding term. Verified by mutation — with the ref
    // check in place, adding or removing the state check changes no test.
    //
    // Getting this wrong is not a near-miss. `loadPlaygroundGeometry` consults
    // `isCancelled()` only AFTER `process()` resolves, so a leaked first pass
    // pays for the entire WASM boot and tessellation before anything bails.
    if (!sceneHandleRef.current) return;
    if (!model) {
      sceneHandleRef.current?.unloadModel();
      setPhase('idle');
      setMeshCount(0);
      return;
    }
    void loadPlaygroundGeometry(model, {
      isCancelled: () => cancelled,
      setPhase,
      setPhaseMsg,
      onMeshes: (meshes) => {
        sceneHandleRef.current?.loadMeshes(meshes, model);
        setMeshCount(meshes.length);
      },
      onReady,
    });
    return () => { cancelled = true; };
  }, [model, onReady, sceneHandleRef]);

  return (
    // The outer wrapper must be a positioning context for the absolute
    // canvas container below. We use a Tailwind class for `relative` so it
    // doesn't fight the parent-supplied `className` (the parent typically
    // passes `absolute inset-0` to drop us into a sized box).
    <div
      className={cn('relative', className ?? 'h-full w-full')}
      style={{ background: BG_COLOR }}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {/* No WebGL context on this device (#2401). Only the 3D panel degrades:
          the model is still parsed, every query / validation / BCF tool still
          answers, and the agent transcript around us is untouched. Saying so
          explicitly beats a black rectangle, and beats the whole page being
          replaced by an unrecoverable "Reload" card, which is what an
          unguarded `new THREE.WebGLRenderer` produced. */}
      {unavailable && (
        <div
          role="status"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            color: 'rgba(237,228,211,0.55)',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            background: BG_COLOR,
            padding: 16,
            textAlign: 'center',
          }}
        >
          <span>3D preview unavailable on this device</span>
          <span style={{ fontSize: 10, opacity: 0.75, maxWidth: 320 }}>
            Your browser could not provide graphics for the viewer. Loading, queries
            and every other tool still work.
          </span>
        </div>
      )}
      {/* phase HUD — small hairline tag so the user can see whether
          geometry processing actually landed even when the canvas is dark */}
      {!unavailable && phase === 'ready' && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 10,
            color: '#d6ff3f',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            pointerEvents: 'none',
            opacity: 0.7,
          }}
        >
          ● {meshCount} meshes
        </div>
      )}
      {!unavailable && phase !== 'ready' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: phase === 'error' ? '#ff8d8d' : 'rgba(237,228,211,0.55)',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            background: BG_COLOR,
            padding: 16,
            textAlign: 'center',
          }}
        >
          {phase === 'processing' && (
            <span>
              <span className="inline-block animate-pulse">●</span> {phaseMsg || 'preparing…'}
            </span>
          )}
          {phase === 'error' && <span>⚠ {phaseMsg}</span>}
          {phase === 'idle' && <span>load a model first</span>}
        </div>
      )}
    </div>
  );
});
