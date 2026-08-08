/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hero scene factory: renderer, lighting, ground, orbit controls and the
 * animation loop that lerps every element towards the targets the step
 * controller sets.
 *
 * The two halves it wires together:
 *
 *   hero-scene-building.ts   the building geometry, section prop and BCF pin
 *   hero-scene-steps.ts      the twelve-step story arc (`update(step)`)
 *
 * Nothing here runs in CI: happy-dom has no WebGL, so `createScene` is never
 * executed by any suite. Mount it through `useThreeScene`, never straight from
 * an effect — a device that refuses a WebGL context must lose the canvas only,
 * not the page (#2401, see apps/viewer/AGENTS.md).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STOREY, buildHeroBuilding } from './hero-scene-building';
import { createHeroAnimationState, createStepController } from './hero-scene-steps';

const NIGHT = 0x0a0a0c;

export interface SceneHandle {
  update(step: number): void;
  dispose(): void;
  /**
   * Project the BCF pin's world position into the host element's local
   * coordinate space so a sibling HTML overlay can track it through orbit
   * and camera transitions. Returns null when the pin is behind the camera
   * or the host has no size yet.
   */
  projectPin(): { x: number; y: number; visible: boolean } | null;
}

export function createScene(container: HTMLElement): SceneHandle {
  // ── Renderer ─────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(NIGHT, 0);
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';

  // ── Scene + camera ───────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(NIGHT, 18, 42);

  const camera = new THREE.PerspectiveCamera(35, container.clientWidth / container.clientHeight, 0.1, 100);
  camera.position.set(11, 8, 13);
  camera.lookAt(0, 2.5, 0);

  // ── Lighting ─────────────────────────────────────────────────────────────
  scene.add(new THREE.HemisphereLight(0xb6c8ff, 0x1a1a22, 0.6));

  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(8, 14, 6);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xff5cdc, 0.35);
  rim.position.set(-10, 4, -8);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0xd6ff3f, 0.18);
  fill.position.set(-4, 2, 8);
  scene.add(fill);

  // ── Ground ───────────────────────────────────────────────────────────────
  const grid = new THREE.GridHelper(40, 40, 0x2a2a32, 0x16161c);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.5;
  grid.position.y = -0.02;
  scene.add(grid);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(20, 48),
    new THREE.MeshStandardMaterial({ color: 0x0e0e12, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  scene.add(ground);

  const building = buildHeroBuilding(scene);
  const { allElements, sectionPlane, sectionVis, pin, pinTex, pinMat } = building;

  // ── Controls ─────────────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, STOREY, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.minPolarAngle = Math.PI / 4;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.45;

  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  controls.addEventListener('start', () => {
    controls.autoRotate = false;
    if (resumeTimer) clearTimeout(resumeTimer);
  });
  controls.addEventListener('end', () => {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { controls.autoRotate = true; }, 2200);
  });

  // ── Resize ───────────────────────────────────────────────────────────────
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  });
  ro.observe(container);

  const state = createHeroAnimationState();

  // ── Animation loop ───────────────────────────────────────────────────────
  let raf = 0;
  let disposed = false;
  function tick() {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    controls.update();

    for (const el of allElements) {
      const mat = el.mesh.material as THREE.MeshStandardMaterial;
      mat.color.lerp(el.targetColor, 0.07);
      const targetOpacity = el.hidden ? 0 : el.targetOpacity;
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, targetOpacity, 0.07);
      mat.transparent = mat.opacity < 0.999;
      // Optional Y slide (used for the new-door reveal)
      if (el.baseY !== undefined && el.yOffset !== undefined) {
        const targetY = el.baseY + el.yOffset;
        el.mesh.position.y = THREE.MathUtils.lerp(el.mesh.position.y, targetY, 0.08);
      }
    }

    // Section plane tween
    sectionPlane.constant = THREE.MathUtils.lerp(sectionPlane.constant, state.sectionConstantTarget, 0.08);
    const sectMat = sectionVis.material as THREE.MeshBasicMaterial;
    sectMat.opacity = THREE.MathUtils.lerp(sectMat.opacity, state.sectionVisOpacityTarget, 0.1);

    // BCF pin sprite tween
    pinMat.opacity = THREE.MathUtils.lerp(pinMat.opacity, state.pinOpacityTarget, 0.12);

    camera.position.lerp(state.cameraTarget, 0.04);
    renderer.render(scene, camera);
  }
  tick();

  // ── State controller ────────────────────────────────────────────────────
  const update = createStepController(building, state);

  update(0);

  // Re-usable scratch vector to avoid alloc churn in projectPin().
  const projScratch = new THREE.Vector3();

  return {
    update,
    projectPin() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return null;
      projScratch.copy(pin.position).project(camera);
      const visible = projScratch.z >= -1 && projScratch.z <= 1;
      return {
        x: ((projScratch.x + 1) / 2) * w,
        y: ((-projScratch.y + 1) / 2) * h,
        visible,
      };
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      if (resumeTimer) clearTimeout(resumeTimer);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      // The pin sprite uses a CanvasTexture allocated outside the
      // material-walk above (the sprite material's `map` is set, but
      // scene.traverse only disposes materials & geometries). Drop it
      // explicitly so the canvas-backed GPU texture doesn't leak across
      // mount/unmount cycles.
      pinTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    },
  };
}
