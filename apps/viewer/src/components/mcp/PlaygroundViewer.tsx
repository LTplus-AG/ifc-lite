/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PlaygroundViewer — collapsible inline 3D viewer for /mcp/playground.
 *
 * Loads geometry from a parsed `IfcDataStore` via @ifc-lite/geometry's WASM
 * processor (`GeometryProcessor.process(buffer)`), renders one Three.js
 * mesh per IFC entity so each can be coloured / hidden / picked
 * individually, and exposes an imperative `ViewerController` that the
 * agent's tool dispatcher drives.
 *
 * Why per-entity meshes (not a merged mesh): the agent loop calls things
 * like `viewer_colorize({ global_ids: [...] })` and we need to flip just
 * those entities. Sharing one BufferGeometry would force per-vertex colour
 * attributes + a custom shader pass, which is overkill for the playground
 * scale (≤ ~1k visible entities for the bundled samples).
 *
 * Geometry processing is async + heavy → only fired the first time the
 * panel is opened, then the result is cached.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import { EntityNode } from '@ifc-lite/query';
import { cn } from '@/lib/utils';
import type { LoadedPlaygroundModel } from './playground-dispatcher';

const NIGHT = 0x0a0a0c;
const ACCENT = 0xd6ff3f;
const BG_COLOR = '#0e0e12';

// ── controller surface used by the dispatcher ──────────────────────────────

export interface SelectionHit {
  expressId: number;
  globalId?: string;
  ifcType?: string;
}

export interface ViewerStatus {
  loaded: boolean;
  meshCount: number;
  selection: SelectionHit[];
}

export type ColorTuple = [number, number, number, number];

export interface ViewerController {
  isLoaded(): boolean;
  status(): ViewerStatus;
  /** Colour the selected entities. Pass null/undefined to default to all. */
  colorize(args: { globalIds?: string[]; expressIds?: number[]; type?: string; color: ColorTuple }): { count: number };
  isolate(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): { count: number };
  hide(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): { count: number };
  show(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): { count: number };
  reset(): void;
  flyTo(args: { globalIds?: string[]; expressIds?: number[] }): { count: number };
  setSection(args: { axis: 'x' | 'y' | 'z'; position: number }): void;
  clearSection(): void;
  colorByStorey(): { groups: number };
  colorByProperty(args: {
    type: string;
    pset: string;
    property: string;
    sample: (expressId: number) => string | number | boolean | null;
  }): { legend: Array<{ value: string; count: number; color: ColorTuple }> };
  getSelection(): SelectionHit[];
  setOnSelectionChange(handler: ((hits: SelectionHit[]) => void) | null): void;
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
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneHandleRef = useRef<SceneHandle | null>(null);
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
    }),
    [meshCount],
  );

  // Mount Three.js once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handle = createScene(container);
    sceneHandleRef.current = handle;
    return () => {
      handle.dispose();
      sceneHandleRef.current = null;
    };
  }, []);

  // Load geometry whenever the model changes (and the component is mounted —
  // the parent decides when to mount us).
  useEffect(() => {
    let cancelled = false;
    if (!model) {
      sceneHandleRef.current?.unloadModel();
      setPhase('idle');
      setMeshCount(0);
      return;
    }
    void (async () => {
      setPhase('processing');
      setPhaseMsg('booting geometry pipeline…');
      try {
        const processor = new GeometryProcessor({ preferNative: false });
        await processor.init();
        setPhaseMsg('extracting geometry…');
        // Use our owning byte snapshot — store.source can be a sub-view that
        // the parser detached internally on big files.
        const result = await processor.process(
          model.bytes,
          model.store.entityIndex.byId as unknown as Map<number, unknown>,
        );
        if (cancelled) return;
        const meshes = result.meshes ?? [];
        // eslint-disable-next-line no-console
        console.log('[playground-viewer] geometry result:', {
          meshCount: meshes.length,
          firstMeshVerts: meshes[0]?.positions?.length,
          coordinateInfo: result.coordinateInfo,
        });
        if (meshes.length === 0) {
          setPhase('error');
          setPhaseMsg('No drawable geometry — model may be schema-only.');
          return;
        }
        sceneHandleRef.current?.loadMeshes(meshes, model);
        setMeshCount(meshes.length);
        setPhase('ready');
        onReady?.();
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[playground-viewer] geometry processing failed', err);
        setPhase('error');
        setPhaseMsg(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [model, onReady]);

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
      {/* phase HUD — small hairline tag so the user can see whether
          geometry processing actually landed even when the canvas is dark */}
      {phase === 'ready' && (
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
      {phase !== 'ready' && (
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

// ── scene factory + per-entity book-keeping ────────────────────────────────

interface SceneHandle {
  loadMeshes(meshes: MeshData[], model: LoadedPlaygroundModel): void;
  unloadModel(): void;
  colorize(args: { globalIds?: string[]; expressIds?: number[]; type?: string; color: ColorTuple }): { count: number };
  isolate(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): { count: number };
  hide(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): { count: number };
  show(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): { count: number };
  reset(): void;
  flyTo(args: { globalIds?: string[]; expressIds?: number[] }): { count: number };
  setSection(args: { axis: 'x' | 'y' | 'z'; position: number }): void;
  clearSection(): void;
  colorByStorey(): { groups: number };
  colorByProperty(args: {
    type: string;
    pset: string;
    property: string;
    sample: (expressId: number) => string | number | boolean | null;
  }): { legend: Array<{ value: string; count: number; color: ColorTuple }> };
  getSelection(): SelectionHit[];
  setOnSelectionChange(handler: ((hits: SelectionHit[]) => void) | null): void;
  dispose(): void;
}

interface EntityRecord {
  expressId: number;
  globalId?: string;
  ifcType?: string;
  storeyName?: string;
  mesh: THREE.Mesh;
  baseColor: THREE.Color;
  baseOpacity: number;
}

function createScene(container: HTMLElement): SceneHandle {
  // ── Renderer ─────────────────────────────────────────────────────────────
  // Mirrors examples/threejs-viewer EXACTLY (renderer setup, lighting,
  // material settings, camera). The only difference is that we render to
  // a divs-attached canvas (not document.getElementById('viewer')).
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(NIGHT, 1);
  renderer.localClippingEnabled = true;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(NIGHT);

  const camera = new THREE.PerspectiveCamera(50, container.clientWidth / Math.max(1, container.clientHeight), 0.1, 10000);
  camera.position.set(20, 15, 20);
  camera.lookAt(0, 0, 0);

  // Lighting (parity with the threejs-viewer example).
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 0.8);
  key.position.set(50, 80, 50);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xb0c4de, 0.3);
  fill.position.set(-30, 10, -20);
  scene.add(fill);

  // Reusable group so loadMeshes can clear without affecting lights.
  // No rotation here: @ifc-lite/geometry already converts IFC Z-up to
  // Three.js Y-up at the vertex level (swap Y/Z + negate new Z to keep
  // right-handedness). Adding a second rotation here was tipping the
  // whole building on its side.
  const modelGroup = new THREE.Group();
  scene.add(modelGroup);

  // Section plane (Y-axis in three space ↔ Z in IFC after rotation).
  const sectionPlanes: THREE.Plane[] = [];
  let activeSectionPlane: THREE.Plane | null = null;

  // Controls.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // ── per-entity registry ─────────────────────────────────────────────────
  const records: EntityRecord[] = [];
  const byExpressId = new Map<number, EntityRecord>();
  const byGlobalId = new Map<string, EntityRecord>();
  const byType = new Map<string, EntityRecord[]>();
  const byStorey = new Map<string, EntityRecord[]>();
  let modelRef: LoadedPlaygroundModel | null = null;
  let selection: SelectionHit[] = [];
  let selectionListener: ((hits: SelectionHit[]) => void) | null = null;

  // ── Picking ─────────────────────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const SELECTION_COLOR = new THREE.Color(0xff5cdc);

  function onPointerUp(e: PointerEvent) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const visibleMeshes = records.filter((r) => r.mesh.visible).map((r) => r.mesh);
    const hits = raycaster.intersectObjects(visibleMeshes, false);
    if (hits.length === 0) {
      // Empty pick — clear selection.
      clearSelectionHighlight();
      selection = [];
      selectionListener?.(selection);
      return;
    }
    const hit = hits[0].object as THREE.Mesh;
    const rec = records.find((r) => r.mesh === hit);
    if (!rec) return;
    clearSelectionHighlight();
    (rec.mesh.material as THREE.MeshStandardMaterial).color.copy(SELECTION_COLOR);
    selection = [{ expressId: rec.expressId, globalId: rec.globalId, ifcType: rec.ifcType }];
    selectionListener?.(selection);
  }

  function clearSelectionHighlight() {
    for (const r of records) {
      (r.mesh.material as THREE.MeshStandardMaterial).color.copy(r.baseColor);
    }
  }

  // Drag-vs-click discrimination: only treat as click if the pointer didn't
  // move more than 4 px between down + up.
  let downX = 0, downY = 0;
  renderer.domElement.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) < 4) onPointerUp(e);
  });

  // ── animation loop ──────────────────────────────────────────────────────
  let raf = 0;
  let disposed = false;
  function tick() {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  }
  tick();

  // Resize.
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  });
  ro.observe(container);

  // ── helpers ─────────────────────────────────────────────────────────────
  function clearModel() {
    for (const r of records) {
      r.mesh.geometry.dispose();
      const mat = r.mesh.material as THREE.Material;
      mat.dispose();
      modelGroup.remove(r.mesh);
    }
    records.length = 0;
    byExpressId.clear();
    byGlobalId.clear();
    byType.clear();
    byStorey.clear();
    selection = [];
    modelRef = null;
  }

  function selectTargets(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): EntityRecord[] {
    const out = new Set<EntityRecord>();
    if (args.expressIds) for (const id of args.expressIds) {
      const r = byExpressId.get(id); if (r) out.add(r);
    }
    if (args.globalIds) for (const gid of args.globalIds) {
      const r = byGlobalId.get(gid); if (r) out.add(r);
    }
    if (args.type) {
      // Match by leading IfcType (case-insensitive). The geometry pipeline
      // strips the "Ifc" prefix or upper-cases freely depending on schema,
      // so we tolerate either form.
      const want = args.type.toLowerCase();
      for (const [t, list] of byType) {
        if (t.toLowerCase() === want) for (const r of list) out.add(r);
      }
    }
    if (out.size === 0 && !args.expressIds && !args.globalIds && !args.type) {
      // No targets specified → all
      for (const r of records) out.add(r);
    }
    return Array.from(out);
  }

  /** Compute the world-space bounding box of a set of records. Robust to
   *  the modelGroup's Y-up rotation: forces matrixWorld update first, then
   *  expands the box by each geometry's local bbox transformed into world. */
  function worldBox(records: EntityRecord[]): THREE.Box3 {
    modelGroup.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    for (const r of records) {
      r.mesh.geometry.computeBoundingBox();
      const local = r.mesh.geometry.boundingBox;
      if (!local || !isFinite(local.min.x) || !isFinite(local.max.x)) continue;
      tmp.copy(local).applyMatrix4(r.mesh.matrixWorld);
      box.union(tmp);
    }
    return box;
  }

  /** Fit the camera + orbit target to a record set. If `instant` is true the
   *  camera snaps; otherwise it tweens (used by viewer_fly_to). */
  function frameOn(records: EntityRecord[], instant = false) {
    if (records.length === 0) return;
    const box = worldBox(records);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const radius = (maxDim || 1) * 0.6 + 1;
    // Place camera diagonally above + offset so the building reads in
    // perspective. Distance scales with the model size so a 5 m hut and a
    // 200 m bridge both frame nicely.
    const dir = new THREE.Vector3(0.55, 0.55, 0.62).normalize();
    const distance = Math.max(radius * 2.6, maxDim * 1.4 + 4);
    const target = center.clone().add(dir.multiplyScalar(distance));

    // Tighten the camera near/far plane so big georeferenced bboxes don’t
    // crush precision into one z-buffer slab.
    camera.near = Math.max(0.05, distance / 5000);
    camera.far = Math.max(500, distance * 20);
    camera.updateProjectionMatrix();

    if (instant) {
      camera.position.copy(target);
      controls.target.copy(center);
      controls.update();
      return;
    }
    // Animate camera/target — single tween via lerp on rAF.
    const startPos = camera.position.clone();
    const startTarget = controls.target.clone();
    const startedAt = performance.now();
    const dur = 600;
    function tween() {
      if (disposed) return;
      const t = Math.min(1, (performance.now() - startedAt) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      camera.position.lerpVectors(startPos, target, e);
      controls.target.lerpVectors(startTarget, center, e);
      controls.update();
      if (t < 1) requestAnimationFrame(tween);
    }
    tween();
  }

  return {
    loadMeshes(meshes, model) {
      clearModel();
      modelRef = model;

      // Build per-entity records.
      //
      // CRITICAL: side = THREE.DoubleSide for every material, regardless
      // of opacity. The IFC geometry pipeline produces meshes whose
      // triangle winding is INCONSISTENT — some triangles are CCW, some
      // are CW. The native @ifc-lite/renderer pipeline turns culling
      // off everywhere for the same reason (see
      // packages/renderer/src/pipeline.ts:141 — "Disable culling to debug
      // - IFC winding order varies"). Using FrontSide here culls roughly
      // half the triangles per element, which is exactly the
      // "see-through, back faces visible" symptom we hit. DoubleSide
      // costs us a few percent fillrate but renders correctly.
      //
      // We also call computeVertexNormals() defensively in case any
      // mesh's normal buffer is stale or zeroed out — the geometry
      // pipeline writes them but we want to be sure shading reads right.
      let opaqueCount = 0;
      let transparentCount = 0;
      for (const md of meshes) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(md.positions, 3));
        geom.setAttribute('normal', new THREE.BufferAttribute(md.normals, 3));
        geom.setIndex(new THREE.BufferAttribute(md.indices, 1));
        // If the supplied normals are degenerate (all zeros), regenerate
        // from the indexed triangles. Cheap if normals were already good.
        const n = md.normals;
        if (n.length === 0 || (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2])) < 1e-6) {
          geom.computeVertexNormals();
        }
        geom.computeBoundingSphere();
        const [r, g, b, a] = md.color;
        const baseColor = new THREE.Color(r, g, b);
        const isTransparent = a < 1;
        if (isTransparent) transparentCount++; else opaqueCount++;
        const mat = new THREE.MeshStandardMaterial({
          color: baseColor,
          transparent: isTransparent,
          opacity: a,
          side: THREE.DoubleSide, // see comment above
          depthWrite: !isTransparent,
          clippingPlanes: sectionPlanes,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.expressId = md.expressId;
        mesh.userData.ifcType = md.ifcType;
        modelGroup.add(mesh);

        let globalId: string | undefined;
        let ifcType: string | undefined = md.ifcType;
        let storeyName: string | undefined;
        // Resolve more accurate IFC metadata from the parsed store.
        if (model.store.entityIndex.byId.has(md.expressId)) {
          try {
            const node = new EntityNode(model.store, md.expressId);
            globalId = node.globalId || undefined;
            if (!ifcType || ifcType === 'IfcProduct') ifcType = node.type;
            const storey = node.storey();
            if (storey) storeyName = storey.name;
          } catch { /* keep the geometry-derived fallbacks */ }
        }

        const rec: EntityRecord = {
          expressId: md.expressId,
          globalId,
          ifcType,
          storeyName,
          mesh,
          baseColor,
          baseOpacity: md.color[3],
        };
        records.push(rec);
        byExpressId.set(md.expressId, rec);
        if (globalId) byGlobalId.set(globalId, rec);
        if (ifcType) {
          const list = byType.get(ifcType) ?? [];
          list.push(rec);
          byType.set(ifcType, list);
        }
        if (storeyName) {
          const list = byStorey.get(storeyName) ?? [];
          list.push(rec);
          byStorey.set(storeyName, list);
        }
      }

      // Snap the camera to the loaded model immediately (no tween — there’s
      // nothing to tween from on first load).
      frameOn(records, true);
      // eslint-disable-next-line no-console
      console.log('[playground-viewer] mounted meshes:', {
        count: records.length,
        opaque: opaqueCount,
        transparent: transparentCount,
        bbox: (() => {
          const b = worldBox(records);
          return b.isEmpty() ? null : { min: b.min.toArray(), max: b.max.toArray() };
        })(),
        camera: camera.position.toArray(),
        target: controls.target.toArray(),
        firstColors: meshes.slice(0, 3).map((m) => m.color),
      });
    },

    unloadModel() {
      clearModel();
    },

    colorize(args) {
      const targets = selectTargets(args);
      const c = new THREE.Color(args.color[0], args.color[1], args.color[2]);
      for (const r of targets) {
        const mat = r.mesh.material as THREE.MeshStandardMaterial;
        mat.color.copy(c);
        // Treat the new colour as the "base" so picking-clear restores it.
        r.baseColor.copy(c);
        if (args.color[3] != null && args.color[3] < 0.999) {
          mat.transparent = true;
          mat.opacity = args.color[3];
          r.baseOpacity = args.color[3];
        }
      }
      return { count: targets.length };
    },

    isolate(args) {
      const targets = new Set(selectTargets(args));
      for (const r of records) {
        r.mesh.visible = targets.has(r);
      }
      return { count: targets.size };
    },

    hide(args) {
      const targets = selectTargets(args);
      for (const r of targets) r.mesh.visible = false;
      return { count: targets.length };
    },

    show(args) {
      const targets = selectTargets(args);
      for (const r of targets) r.mesh.visible = true;
      return { count: targets.length };
    },

    reset() {
      for (const r of records) {
        r.mesh.visible = true;
        const mat = r.mesh.material as THREE.MeshStandardMaterial;
        mat.color.copy(r.baseColor);
        mat.opacity = r.baseOpacity;
        mat.transparent = r.baseOpacity < 0.999;
      }
      activeSectionPlane = null;
      sectionPlanes.length = 0;
    },

    flyTo(args) {
      const targets = selectTargets(args);
      if (targets.length === 0) return { count: 0 };
      frameOn(targets);
      return { count: targets.length };
    },

    setSection({ axis, position }) {
      sectionPlanes.length = 0;
      // Geometry is in Three.js coordinates (Y is up after the geometry
      // pipeline's Z-up→Y-up conversion). The agent's `axis` arg is read
      // in the same convention: 'y' is the horizontal "cut the top off"
      // plane, 'x' / 'z' are vertical slabs perpendicular to those world
      // axes. Three.js clipping plane keeps points where n·x + d > 0.
      const normal = new THREE.Vector3(
        axis === 'x' ? -1 : 0,
        axis === 'y' ? -1 : 0,
        axis === 'z' ? -1 : 0,
      );
      activeSectionPlane = new THREE.Plane(normal, position);
      sectionPlanes.push(activeSectionPlane);
      for (const r of records) {
        const mat = r.mesh.material as THREE.MeshStandardMaterial;
        mat.clippingPlanes = sectionPlanes;
        mat.needsUpdate = true;
      }
    },

    clearSection() {
      sectionPlanes.length = 0;
      activeSectionPlane = null;
      for (const r of records) {
        const mat = r.mesh.material as THREE.MeshStandardMaterial;
        mat.clippingPlanes = [];
        mat.needsUpdate = true;
      }
    },

    colorByStorey() {
      // Distinct hue per storey. HSV evenly spaced.
      const storeyNames = Array.from(byStorey.keys());
      storeyNames.forEach((name, i) => {
        const h = (i / Math.max(1, storeyNames.length)) * 0.85;
        const c = new THREE.Color().setHSL(h, 0.6, 0.55);
        for (const r of byStorey.get(name) ?? []) {
          (r.mesh.material as THREE.MeshStandardMaterial).color.copy(c);
          r.baseColor.copy(c);
        }
      });
      return { groups: storeyNames.length };
    },

    colorByProperty({ type, sample }) {
      const records = byType.get(type) ?? [];
      const buckets = new Map<string, EntityRecord[]>();
      for (const r of records) {
        const v = sample(r.expressId);
        const key = v == null ? '(missing)' : String(v);
        const list = buckets.get(key) ?? [];
        list.push(r);
        buckets.set(key, list);
      }
      const PALETTE: ColorTuple[] = [
        [0.84, 1.0, 0.25, 1],
        [0.48, 0.45, 0.95, 1],
        [1.0, 0.36, 0.86, 1],
        [0.45, 0.85, 0.79, 1],
        [1.0, 0.62, 0.39, 1],
        [0.62, 0.81, 0.42, 1],
        [0.50, 0.50, 0.55, 1],
      ];
      const legend: Array<{ value: string; count: number; color: ColorTuple }> = [];
      let i = 0;
      for (const [value, list] of buckets) {
        const color = value === '(missing)' ? [0.4, 0.4, 0.45, 1] as ColorTuple : PALETTE[i++ % PALETTE.length];
        const c = new THREE.Color(color[0], color[1], color[2]);
        for (const r of list) {
          (r.mesh.material as THREE.MeshStandardMaterial).color.copy(c);
          r.baseColor.copy(c);
        }
        legend.push({ value, count: list.length, color });
      }
      return { legend };
    },

    getSelection() {
      return selection;
    },

    setOnSelectionChange(h) {
      selectionListener = h;
    },

    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      clearModel();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    },
  };

  // Avoid "unused" lint flag on the modelRef helper.
  void modelRef;
}
