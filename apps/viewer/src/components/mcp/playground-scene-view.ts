/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera framing and section control for the playground scene.
 *
 * The two things that move the *view* rather than the entities: fitting the
 * camera to a record set (`viewer_fly_to`, plus the snap on first load) and
 * the clipping plane behind `viewer_set_section` / `viewer_clear_section`.
 * Kept apart from `playground-scene-ops.ts`, which only ever touches
 * materials and visibility.
 */

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { EntityRecord } from './playground-scene-registry';

/**
 * The live clipping-plane array. Every entity material is constructed with a
 * reference to `planes`, so mutating it in place (never reassigning) is what
 * makes a section apply to meshes that already exist.
 */
export interface SectionState {
  planes: THREE.Plane[];
  active: THREE.Plane | null;
}

export function createSectionState(): SectionState {
  return { planes: [], active: null };
}

/** Everything `frameOn` needs from the scene. `isDisposed` is read fresh on
 *  every tween frame so a teardown mid-flight stops the rAF chain. */
export interface SceneView {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  modelGroup: THREE.Group;
  isDisposed: () => boolean;
}

/** Compute the world-space bounding box of a set of records. Robust to
 *  the modelGroup's Y-up rotation: forces matrixWorld update first, then
 *  expands the box by each geometry's local bbox transformed into world. */
export function worldBox(modelGroup: THREE.Group, records: EntityRecord[]): THREE.Box3 {
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
export function frameOn(view: SceneView, records: EntityRecord[], instant = false): void {
  const { camera, controls, modelGroup, isDisposed } = view;
  if (records.length === 0) return;
  const box = worldBox(modelGroup, records);
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
    if (isDisposed()) return;
    const t = Math.min(1, (performance.now() - startedAt) / dur);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    camera.position.lerpVectors(startPos, target, e);
    controls.target.lerpVectors(startTarget, center, e);
    controls.update();
    if (t < 1) requestAnimationFrame(tween);
  }
  tween();
}

export function setSection(
  section: SectionState,
  records: EntityRecord[],
  { axis, position }: { axis: 'x' | 'y' | 'z'; position: number },
): void {
  section.planes.length = 0;
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
  section.active = new THREE.Plane(normal, position);
  section.planes.push(section.active);
  for (const r of records) {
    const mat = r.mesh.material as THREE.MeshStandardMaterial;
    mat.clippingPlanes = section.planes;
    mat.needsUpdate = true;
  }
}

export function clearSection(section: SectionState, records: EntityRecord[]): void {
  section.planes.length = 0;
  section.active = null;
  for (const r of records) {
    const mat = r.mesh.material as THREE.MeshStandardMaterial;
    mat.clippingPlanes = [];
    mat.needsUpdate = true;
  }
}
