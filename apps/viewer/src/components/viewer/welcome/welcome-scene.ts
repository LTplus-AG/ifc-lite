/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The start screen's 3D mark: the IFClite logo's four extrusions. Most of the
 * time it IS the logo — solid columns, fine outlines. Every few seconds it
 * opens a little into its three layers (the IFC5 idea of a model composed
 * from layers), with a tinted plate under each, then closes again. Drag to
 * spin it; hover a block to tag it.
 *
 * Mount it through `useThreeScene` (never straight from an effect,
 * apps/viewer/AGENTS.md): a device that refuses a WebGL context loses this
 * canvas, not the welcome screen. Nothing here runs in CI — happy-dom has no
 * WebGL — so the geometry, timing and tag data live in
 * `welcome-scene-layout.ts`, which is plain data and is tested.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { releaseRenderer } from '@/components/mcp/release-renderer';
import { LAYER_BANDS, MAX_LAYER_GAP, explodeAt, sliceLogoIntoBands, type BandBox } from './welcome-scene-layout';

/** A hovered box: which layer band and which of the four columns. */
export interface WelcomeHoverTarget {
  layer: number;
  column: number;
}

export interface WelcomeSceneEvents {
  /** The hovered box changed (null: nothing hovered). Fires on change only. */
  onHover(target: WelcomeHoverTarget | null): void;
  /** Every frame while something is hovered: the top of the box, in container px. */
  onTagAnchor(x: number, y: number): void;
}

export interface WelcomeSceneHandle {
  setDark(dark: boolean): void;
  dispose(): void;
}

interface Palette { face: string; edge: string; hover: string; layers: readonly string[]; shadow: number; plate: number }

const DARK: Palette = { face: '#aab9c8', edge: '#2f4352', hover: '#7aa2f7', layers: ['#7aa2f7', '#bb9af7', '#73daca'], shadow: 0.36, plate: 0.14 };
const LIGHT: Palette = { face: '#c3cfda', edge: '#3e5566', hover: '#2f6fe4', layers: ['#2f6fe4', '#8b5cf6', '#0d9488'], shadow: 0.13, plate: 0.16 };

/** Outline width, CSS px: fine, but not hairline on a 1x screen. */
const EDGE_PX = 1.25;
const HOVER_EDGE_PX = 2;
/** Face tint towards the layer colour while apart (0 when assembled). */
const LAYER_TINT = 0.24;

/** Half-height of the orthographic frustum, in model units, and the half-width
 *  the mark needs (layer plates seen from any yaw) so a narrow column zooms
 *  out instead of cropping the sides. */
const VIEW = 3.7;
const HALF_WIDTH = 2.9;
const TARGET = new THREE.Vector3(0, 2.2, 0);
/** Auto-rotate resumes this long after the user lets go. */
const RESUME_MS = 2500;

/** Box edges in box-local space, split into the column's own outline and the
 *  cut rings that only exist because the column was sliced into layers. */
function boxEdges(box: BandBox): { outer: number[]; cut: number[] } {
  const x = box.width / 2;
  const y = box.height / 2;
  const z = box.depth / 2;
  const ring = (h: number) => [
    -x, h, -z, x, h, -z, x, h, -z, x, h, z, x, h, z, -x, h, z, -x, h, z, -x, h, -z,
  ];
  const outer = [
    -x, -y, -z, -x, y, -z, x, -y, -z, x, y, -z, x, -y, z, x, y, z, -x, -y, z, -x, y, z,
  ];
  const cut: number[] = [];
  (box.cutBelow ? cut : outer).push(...ring(-y));
  (box.cutAbove ? cut : outer).push(...ring(y));
  return { outer, cut };
}

export function createWelcomeScene(container: HTMLElement, dark: boolean, events: WelcomeSceneEvents): WelcomeSceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.display = 'block';
  canvas.style.cursor = 'grab';

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-VIEW, VIEW, VIEW, -VIEW, -50, 50);
  const yaw = Math.PI / 4;
  const pitch = 0.58;
  camera.position.set(
    TARGET.x + Math.cos(pitch) * Math.cos(yaw) * 10,
    TARGET.y + Math.sin(pitch) * 10,
    TARGET.z + Math.cos(pitch) * Math.sin(yaw) * 10,
  );
  camera.lookAt(TARGET);

  const hemi = new THREE.HemisphereLight(0xe6ecff, 0x1a1b26, 1.3);
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(-2, 12, 3.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0006;
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5 });
  sun.shadow.radius = 6;
  const fill = new THREE.DirectionalLight(0x9db8ff, 0.45);
  fill.position.set(6, 3, -4);
  scene.add(hemi, sun, fill);

  const shadowMaterial = new THREE.ShadowMaterial({ opacity: DARK.shadow });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), shadowMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Lines: one width for the outline, a fading copy for the cut rings, a
  // heavier blue one for the hovered box.
  const edgeLine = new LineMaterial({ linewidth: EDGE_PX });
  const cutLine = new LineMaterial({ linewidth: EDGE_PX, transparent: true, depthWrite: false });
  const hoverLine = new LineMaterial({ linewidth: HOVER_EDGE_PX });
  const lineMaterials = [edgeLine, cutLine, hoverLine];

  // One group per layer band, so the explode only moves groups.
  const bandGroups: THREE.Group[] = [];
  const faceMaterials: THREE.MeshStandardMaterial[] = [];
  const plates: THREE.Mesh[] = [];
  const plateMaterials: THREE.MeshStandardMaterial[] = [];
  const plateEdgeMaterials: THREE.LineBasicMaterial[] = [];
  const hoverMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55, emissiveIntensity: 0.22, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const geometries: { dispose(): void }[] = [];
  const pickable: THREE.Mesh[] = [];
  const faceBase = new THREE.Color();
  const layerColors: THREE.Color[] = [];

  sliceLogoIntoBands().forEach((band, k) => {
    const group = new THREE.Group();
    const plateGeometry = new THREE.BoxGeometry(3.3, 0.03, 3.3);
    const plateEdges = new THREE.EdgesGeometry(plateGeometry);
    geometries.push(plateGeometry, plateEdges);
    const plateMaterial = new THREE.MeshStandardMaterial({ transparent: true, roughness: 1, depthWrite: false });
    const plateEdgeMaterial = new THREE.LineBasicMaterial({ transparent: true });
    plateMaterials.push(plateMaterial);
    plateEdgeMaterials.push(plateEdgeMaterial);
    const plate = new THREE.Mesh(plateGeometry, plateMaterial);
    plate.position.y = LAYER_BANDS[k][0] - 0.04;
    plate.add(new THREE.LineSegments(plateEdges, plateEdgeMaterial));
    plates.push(plate);
    group.add(plate);
    layerColors.push(new THREE.Color());

    // Faces sit a hair behind their outlines so lines never z-fight.
    const faceMaterial = new THREE.MeshStandardMaterial({ roughness: 0.72, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    faceMaterials.push(faceMaterial);
    for (const box of band) {
      const geometry = new THREE.BoxGeometry(box.width, box.height, box.depth);
      geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, faceMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(box.x, box.y, box.z);
      const { outer, cut } = boxEdges(box);
      const outerGeometry = new LineSegmentsGeometry().setPositions(outer);
      geometries.push(outerGeometry);
      const outerLines = new LineSegments2(outerGeometry, edgeLine);
      outerLines.raycast = () => {}; // pick the box, never its outline
      mesh.add(outerLines);
      let cutLines: LineSegments2 | null = null;
      if (cut.length > 0) {
        const cutGeometry = new LineSegmentsGeometry().setPositions(cut);
        geometries.push(cutGeometry);
        cutLines = new LineSegments2(cutGeometry, cutLine);
        cutLines.raycast = () => {};
        mesh.add(cutLines);
      }
      mesh.userData = { layer: k, column: box.column, top: box.height / 2, face: faceMaterial, outerLines, cutLines };
      pickable.push(mesh);
      group.add(mesh);
    }
    bandGroups.push(group);
    scene.add(group);
  });

  let palette = dark ? DARK : LIGHT;
  const setDark = (isDark: boolean) => {
    palette = isDark ? DARK : LIGHT;
    hemi.intensity = isDark ? 1.3 : 1.7;
    sun.intensity = isDark ? 1.8 : 1.55;
    shadowMaterial.opacity = palette.shadow;
    faceBase.set(palette.face);
    edgeLine.color.set(palette.edge);
    cutLine.color.set(palette.edge);
    hoverLine.color.set(palette.hover);
    hoverMaterial.color.set(palette.face).lerp(new THREE.Color(palette.hover), 0.4);
    hoverMaterial.emissive.set(palette.hover);
    palette.layers.forEach((c, k) => {
      layerColors[k].set(c);
      plateMaterials[k].color.set(c);
      plateEdgeMaterials[k].color.set(c);
    });
  };
  setDark(dark);

  /** Lay the mark out for an explode factor: 0 the logo, 1 three layers. */
  const applyExplode = (f: number) => {
    bandGroups.forEach((group, k) => { group.position.y = k * f * MAX_LAYER_GAP; });
    plates.forEach((plate, k) => {
      plate.visible = f > 0.02;
      plateMaterials[k].opacity = palette.plate * f;
      plateEdgeMaterials[k].opacity = 0.7 * f;
    });
    faceMaterials.forEach((m, k) => { m.color.copy(faceBase).lerp(layerColors[k], LAYER_TINT * f); });
    cutLine.opacity = f;
    cutLine.visible = f > 0.02;
  };

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  // ── Hover: raycast the boxes, highlight one, report it. ─────────────────
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerInside = false;
  let dragging = false;
  let holding = false; // a recent drag: wait RESUME_MS before moving on its own
  let hovered: THREE.Mesh | null = null;
  let controls: OrbitControls | null = null;
  // Turn and breathe on its own only when nobody is dragging, pointing at a
  // block, or just let go — and never under reduced motion.
  const idle = () => !reduceMotion && !dragging && !holding && hovered === null;
  const syncAutoRotate = () => { if (controls) controls.autoRotate = idle(); };
  const setHovered = (mesh: THREE.Mesh | null) => {
    if (mesh === hovered) return;
    const swap = (m: THREE.Mesh, face: THREE.Material, outline: LineMaterial, cut: LineMaterial) => {
      m.material = face;
      (m.userData.outerLines as LineSegments2).material = outline;
      const cutLines = m.userData.cutLines as LineSegments2 | null;
      if (cutLines) cutLines.material = cut;
    };
    if (hovered) swap(hovered, hovered.userData.face as THREE.Material, edgeLine, cutLine);
    hovered = mesh;
    if (mesh) swap(mesh, hoverMaterial, hoverLine, hoverLine);
    if (!dragging) canvas.style.cursor = mesh ? 'pointer' : 'grab';
    syncAutoRotate();
    events.onHover(mesh ? { layer: mesh.userData.layer as number, column: mesh.userData.column as number } : null);
  };
  const onPointerMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    pointerInside = true;
  };
  const onPointerLeave = () => {
    pointerInside = false;
    setHovered(null);
  };
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);

  // ── Orbit: drag to spin. No zoom (the page scrolls) and no pan. ─────────
  const orbit = new OrbitControls(camera, canvas);
  controls = orbit;
  orbit.target.copy(TARGET);
  orbit.enableZoom = false;
  orbit.enablePan = false;
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.rotateSpeed = 0.7;
  orbit.minPolarAngle = 0.45;
  orbit.maxPolarAngle = 1.15;
  orbit.autoRotateSpeed = 0.6;
  orbit.update();
  syncAutoRotate();
  let resumeTimer = 0;
  const onStart = () => {
    dragging = true;
    holding = true;
    window.clearTimeout(resumeTimer);
    canvas.style.cursor = 'grabbing';
    setHovered(null);
    syncAutoRotate();
  };
  const onEnd = () => {
    dragging = false;
    canvas.style.cursor = 'grab';
    resumeTimer = window.setTimeout(() => { holding = false; syncAutoRotate(); }, RESUME_MS);
  };
  orbit.addEventListener('start', onStart);
  orbit.addEventListener('end', onEnd);

  const frame = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    for (const m of lineMaterials) m.resolution.set(w, h);
    const aspect = w / h;
    const half = Math.max(VIEW, HALF_WIDTH / aspect);
    camera.top = half;
    camera.bottom = -half;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.updateProjectionMatrix();
  };
  frame();
  container.appendChild(canvas);

  // The explode clock only runs while idle, so a hovered or dragged mark
  // holds still and picks up exactly where it paused.
  const anchor = new THREE.Vector3();
  let clock = 0;
  let last = performance.now();
  let raf = 0;
  const draw = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (idle()) clock += dt;
    applyExplode(reduceMotion ? 0 : explodeAt(clock));
    orbit.update();
    if (pointerInside && !dragging) {
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(pickable, false)[0];
      setHovered((hit?.object as THREE.Mesh | undefined) ?? null);
    }
    if (hovered) {
      hovered.getWorldPosition(anchor);
      anchor.y += hovered.userData.top as number;
      anchor.project(camera);
      events.onTagAnchor(((anchor.x + 1) / 2) * container.clientWidth, ((1 - anchor.y) / 2) * container.clientHeight);
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);

  const resize = new ResizeObserver(frame);
  resize.observe(container);

  return {
    setDark,
    dispose() {
      cancelAnimationFrame(raf);
      window.clearTimeout(resumeTimer);
      resize.disconnect();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      orbit.removeEventListener('start', onStart);
      orbit.removeEventListener('end', onEnd);
      orbit.dispose();
      for (const g of geometries) g.dispose();
      for (const m of [...faceMaterials, ...plateMaterials, ...plateEdgeMaterials, ...lineMaterials, hoverMaterial, shadowMaterial]) m.dispose();
      ground.geometry.dispose();
      releaseRenderer(renderer, container);
    },
  };
}
