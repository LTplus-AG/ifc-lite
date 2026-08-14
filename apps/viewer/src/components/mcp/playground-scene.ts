/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The playground scene factory: GPU lifecycle, picking, and the `SceneHandle`
 * the component's `ViewerController` forwards to.
 *
 * Everything that survives a single call — the per-entity registry, the colour
 * and visibility operations, and camera/section control — lives in the three
 * sibling modules this one wires together:
 *
 *   playground-scene-registry.ts   one mesh + lookup maps per IFC entity
 *   playground-scene-ops.ts        colorize / isolate / hide / show / reset
 *   playground-scene-view.ts       camera framing + section planes
 *
 * Nothing here runs in CI: happy-dom has no WebGL, so `createScene` is never
 * executed by any suite (see `PlaygroundViewer.test.ts` for why the geometry
 * loader is tested as a standalone function instead).
 *
 * Mount it through `useThreeScene`, never straight from an effect — a device
 * that refuses a WebGL context must lose the canvas only, not the page
 * (#2401, see apps/viewer/AGENTS.md).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SceneHandle, SelectionHit } from './playground-viewer-types';
import {
  buildEntityRecords,
  clearEntityRecords,
  countEntities,
  createEntityRegistry,
  selectTargets,
} from './playground-scene-registry';
import {
  colorByProperty,
  colorByStorey,
  colorize,
  hide,
  isolate,
  reset,
  show,
} from './playground-scene-ops';
import { releaseRenderer } from './release-renderer';
import {
  clearSection,
  createSectionState,
  frameOn,
  setSection,
  worldBox,
  type SceneView,
} from './playground-scene-view';

const NIGHT = 0x0a0a0c;

export function createScene(container: HTMLElement): SceneHandle {
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
  const section = createSectionState();

  // Controls.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // ── per-entity registry ─────────────────────────────────────────────────
  const registry = createEntityRegistry();
  const records = registry.records;
  let selection: SelectionHit[] = [];
  // Multi-subscriber so a temporary listener (e.g. viewer_wait_for_selection)
  // doesn't displace the panel's permanent one. Anything calling
  // `setOnSelectionChange` keeps that single-handler convenience but
  // routes through this set.
  const selectionListeners = new Set<(hits: SelectionHit[]) => void>();
  let convenienceListener: ((hits: SelectionHit[]) => void) | null = null;
  function notifySelection(hits: SelectionHit[]) {
    convenienceListener?.(hits);
    for (const l of selectionListeners) l(hits);
  }

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
      notifySelection(selection);
      return;
    }
    const hit = hits[0].object as THREE.Mesh;
    const rec = records.find((r) => r.mesh === hit);
    if (!rec) return;
    clearSelectionHighlight();
    // The ray hits ONE submesh, but selection is reported per element, so the
    // highlight has to cover every submesh of that element or a split window
    // reads as half-selected (#2443).
    for (const r of registry.byExpressId.get(rec.expressId) ?? [rec]) {
      (r.mesh.material as THREE.MeshStandardMaterial).color.copy(SELECTION_COLOR);
    }
    selection = [{ expressId: rec.expressId, globalId: rec.globalId, ifcType: rec.ifcType }];
    notifySelection(selection);
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
  const view: SceneView = { camera, controls, modelGroup, isDisposed: () => disposed };

  function clearModel() {
    clearEntityRecords(registry, modelGroup);
    selection = [];
  }

  return {
    loadMeshes(meshes, model) {
      clearModel();

      const { opaqueCount, transparentCount } = buildEntityRecords(registry, meshes, model, modelGroup, section);

      // Snap the camera to the loaded model immediately (no tween — there’s
      // nothing to tween from on first load).
      frameOn(view, records, true);
      // eslint-disable-next-line no-console
      console.log('[playground-viewer] mounted meshes:', {
        count: records.length,
        opaque: opaqueCount,
        transparent: transparentCount,
        bbox: (() => {
          const b = worldBox(modelGroup, records);
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
      return colorize(registry, args);
    },

    isolate(args) {
      return isolate(registry, args);
    },

    hide(args) {
      return hide(registry, args);
    },

    show(args) {
      return show(registry, args);
    },

    reset() {
      reset(registry, section);
    },

    flyTo(args) {
      const targets = selectTargets(registry, args);
      if (targets.length === 0) return { count: 0 };
      // Frame on every submesh (a partial bbox is what made the camera fit too
      // tight on multi-part elements) but report entities, like the other ops.
      frameOn(view, targets);
      return { count: countEntities(targets) };
    },

    setSection(args) {
      setSection(section, records, args);
    },

    clearSection() {
      clearSection(section, records);
    },

    colorByStorey() {
      return colorByStorey(registry);
    },

    colorByProperty(args) {
      return colorByProperty(registry, args);
    },

    getSelection() {
      return selection;
    },

    setOnSelectionChange(h) {
      convenienceListener = h;
    },

    subscribeSelection(h) {
      selectionListeners.add(h);
      return () => selectionListeners.delete(h);
    },

    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      clearModel();
      releaseRenderer(renderer, container);
    },
  };

}
