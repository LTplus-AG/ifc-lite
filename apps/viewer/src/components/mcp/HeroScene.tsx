/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HeroScene — the hero’s living building. Real WebGL via Three.js.
 *
 * Twelve agent steps now, picked to span every visible primitive on the MCP
 * surface (Discovery, Query, Validation, Mutation, BCF, bSDD, Viewer):
 *
 *   00  viewer_open                       neutral framing
 *   01  model_audit                       audit badge appears
 *   02  count_entities(group_by="type")   element-count panel slides in
 *   03  viewer_color_by_storey            storey-0 cool blue, storey-1 warm orange
 *   04  viewer_color_by_property(IsExt.)  outer walls vs inner walls split colour
 *   05  viewer_isolate(IfcWall)           non-walls fade out
 *   06  viewer_colorize(IfcWall, "#d6ff3f") chartreuse paint
 *   07  bsdd_property_sets(IfcWall)       Pset list overlay
 *   08  entity_create(IfcDoor)            new door slides into the south wall
 *   09  viewer_set_section(z=2.2)         section plane clips top storey progressively
 *   10  bcf_topic_create("missing rating") red pin appears beside a wall
 *   11  viewer_describe_selection         info card overlays the canvas
 *
 * Steps own three things in parallel:
 *
 *   • visual scene state (driven inside this file via tweened materials,
 *     positions, and three.js clipping planes),
 *   • a transcript line (printed under the canvas by the parent),
 *   • optional UI overlays (badges, pins, panels) the parent renders on
 *     top of the canvas via the exported `HERO_STEPS` data.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const NIGHT = 0x0a0a0c;
const PAPER = 0xede4d3;
const PAPER_DIM = 0x6f6657;
const ACCENT = 0xd6ff3f;     // chartreuse
const ACCENT_2 = 0xff5cdc;   // magenta
const TEAL = 0x73daca;
const STOREY_HUE_LO = 0x4a6fa5; // cool blue
const STOREY_HUE_HI = 0xff9e64; // warm orange
const PROP_TRUE = 0xd6ff3f;     // outer (IsExternal=true)
const PROP_FALSE = 0x7c7cd2;    // inner (IsExternal=false)
const SLAB_DIM = 0x222226;
const NEW_DOOR_HUE = 0xff5cdc;  // freshly-created door pulses magenta

/** Step descriptor — `verb` carries the story-arc headline (1-2 words),
 *  `line` is the technical tool call shown beneath it. Overlays are kept
 *  intentionally sparse: each one shows the smallest piece of evidence
 *  that proves the agent's action landed. */
export interface HeroStep {
  /** One- or two-word verb shown big in display serif. The story arc. */
  verb: string;
  /** Tool call line shown under the verb in mono. The detail. */
  line: string;
  /** Tool category badge ("Validation", "Viewer", …). */
  family: string;
  /** Optional overlay UI key the parent renders inside the canvas frame. */
  overlay?:
    | { kind: 'audit'; score: number; note: string }
    | { kind: 'counts'; rows: Array<{ type: string; n: number }> }
    | { kind: 'psets'; psets: string[] }
    | { kind: 'pin'; ref: string }
    | { kind: 'card'; ref: string; lines: string[] };
}

export const HERO_STEPS: HeroStep[] = [
  { verb: 'Open',      line: 'viewer_open()',                                  family: 'Viewer' },
  { verb: 'Audit',     line: 'model_audit()',                                  family: 'Validation', overlay: { kind: 'audit', score: 74, note: '1 issue' } },
  { verb: 'Survey',    line: 'count_entities(group_by: "type")',               family: 'Query',      overlay: { kind: 'counts', rows: [
      { type: 'Wall',   n: 8 },
      { type: 'Window', n: 12 },
      { type: 'Slab',   n: 3 },
    ] } },
  { verb: 'Layer',     line: 'viewer_color_by_storey()',                       family: 'Viewer' },
  { verb: 'Classify',  line: 'viewer_color_by_property("IsExternal")',         family: 'Viewer' },
  { verb: 'Focus',     line: 'viewer_isolate(IfcWall)',                        family: 'Viewer' },
  { verb: 'Paint',     line: 'viewer_colorize(IfcWall, "#d6ff3f")',            family: 'Viewer' },
  { verb: 'Standardize', line: 'bsdd_property_sets("IfcWall")',                family: 'bSDD',      overlay: { kind: 'psets', psets: ['Pset_WallCommon', 'Qto_WallBaseQuantities', 'Pset_ConcreteElementGeneral'] } },
  { verb: 'Add',       line: 'entity_create(IfcDoor)',                         family: 'Mutation' },
  { verb: 'Section',   line: 'viewer_set_section(z = 2.2)',                    family: 'Viewer' },
  { verb: 'Issue',     line: 'bcf_topic_create("missing fire rating")',        family: 'BCF',       overlay: { kind: 'pin', ref: 'BCF #04' } },
  { verb: 'Inspect',   line: 'viewer_describe_selection()',                    family: 'Viewer',    overlay: { kind: 'card', ref: 'IfcWall #262', lines: ['Pset_WallCommon · IsExternal=true', 'FireRating=EI60 · 240 mm concrete'] } },
];

/** ms each step gets before advancing. */
export const HERO_STEP_MS = 2000;

interface Element {
  mesh: THREE.Mesh;
  baseColor: THREE.Color;
  targetColor: THREE.Color;
  baseOpacity: number;
  targetOpacity: number;
  /** Visible flag — used for the "new door" reveal. */
  hidden?: boolean;
  /** Multiplier for the mesh's stored Y so we can animate the new door sliding in. */
  yOffset?: number;
  baseY?: number;
}

export interface HeroSceneProps {
  /** 0..HERO_STEPS.length-1 — drives material/camera/section animation. */
  step: number;
  className?: string;
  /**
   * Optional callback fired every animation frame with the current
   * screen-space position of the BCF pin (relative to this element's
   * top-left). Used by HeroOverlay to anchor the pin caption.
   */
  onPinFrame?: (frame: { x: number; y: number; visible: boolean } | null) => void;
}

export function HeroScene({ step, className, onPinFrame }: HeroSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const onPinRef = useRef(onPinFrame);
  onPinRef.current = onPinFrame;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handle = createScene(container);
    sceneRef.current = handle;

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      onPinRef.current?.(handle.projectPin());
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      handle.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.update(step);
  }, [step]);

  return (
    <div
      ref={containerRef}
      className={className ?? 'relative aspect-[4/5] w-full overflow-hidden rounded-lg'}
      style={{ background: '#0a0a0c' }}
    />
  );
}

// ── scene factory ──────────────────────────────────────────────────────────

interface SceneHandle {
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

function createScene(container: HTMLElement): SceneHandle {
  const allElements: Element[] = [];

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

  // ── Building geometry ────────────────────────────────────────────────────
  //
  // Spatial conventions (model space, no parent rotation):
  //   • +Z is the FRONT face — the one the default camera (in the +X/+Z
  //     corner) looks at directly. Door + primary window wall live there.
  //   • +X is the RIGHT face — the destination of the agent-created door
  //     in step 8 (so the new entity is unmistakable on a wall that started
  //     out blank).
  //   • Camera auto-rotates around Y, so the back / left faces eventually
  //     come around — we still populate them so the building looks right
  //     from every angle.
  const root = new THREE.Group();
  scene.add(root);

  const W = 8;            // building width  (X)
  const D = 5;            // building depth  (Z)
  const STOREY = 3;       // storey height
  const WALL_THK = 0.18;
  const FRONT_Z = D / 2 + 0.001;
  const BACK_Z = -D / 2 - 0.001;
  const RIGHT_X = W / 2 + 0.001;
  const LEFT_X = -W / 2 - 0.001;

  // Section plane (used by viewer_set_section step). Negative Y axis means
  // we clip everything ABOVE the plane.
  const sectionPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 100); // disabled by default (constant pushed far away)

  function makeMesh(geom: THREE.BufferGeometry, hex: number): THREE.Mesh {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex),
      metalness: 0.05,
      roughness: 0.74,
      clippingPlanes: [sectionPlane],
      clipShadows: true,
    });
    return new THREE.Mesh(geom, mat);
  }
  function registerElement(mesh: THREE.Mesh, baseHex: number, baseOpacity = 1): Element {
    const baseColor = new THREE.Color(baseHex);
    const el: Element = {
      mesh,
      baseColor,
      targetColor: baseColor.clone(),
      baseOpacity,
      targetOpacity: baseOpacity,
      baseY: mesh.position.y,
      yOffset: 0,
    };
    allElements.push(el);
    return el;
  }

  // Slab
  const slab = makeMesh(new THREE.BoxGeometry(W + 0.4, 0.18, D + 0.4), PAPER_DIM);
  slab.position.y = -0.09;
  root.add(slab);
  const slabEl = registerElement(slab, PAPER_DIM);

  // Walls per storey. The two camera-facing walls (FRONT + RIGHT) are
  // tagged "outer" so the color_by_property step splits visibly; BACK +
  // LEFT play "inner". Each face is one solid box — windows + doors sit
  // *on top of* the wall as separate meshes (we’re showing IFC entities,
  // not boolean cuts, so the layered geometry reads better).
  const wallsByStorey: Element[][] = [[], []];
  const externalByStorey: { outer: Element[]; inner: Element[] }[] = [
    { outer: [], inner: [] },
    { outer: [], inner: [] },
  ];
  const windowsByStorey: Element[][] = [[], []];
  const doorEls: Element[] = [];

  for (let storey = 0; storey < 2; storey++) {
    const yMid = storey * STOREY + (STOREY - 0.05) / 2 + 0.05;
    const wallFront = makeMesh(new THREE.BoxGeometry(W, STOREY - 0.05, WALL_THK), 0x6c6c75);
    wallFront.position.set(0, yMid, D / 2);
    const wallBack = makeMesh(new THREE.BoxGeometry(W, STOREY - 0.05, WALL_THK), 0x6c6c75);
    wallBack.position.set(0, yMid, -D / 2);
    const wallRight = makeMesh(new THREE.BoxGeometry(WALL_THK, STOREY - 0.05, D), 0x6c6c75);
    wallRight.position.set(W / 2, yMid, 0);
    const wallLeft = makeMesh(new THREE.BoxGeometry(WALL_THK, STOREY - 0.05, D), 0x6c6c75);
    wallLeft.position.set(-W / 2, yMid, 0);
    [wallFront, wallBack, wallRight, wallLeft].forEach((m) => root.add(m));

    const elFront = registerElement(wallFront, 0x6c6c75);
    const elBack = registerElement(wallBack, 0x6c6c75);
    const elRight = registerElement(wallRight, 0x6c6c75);
    const elLeft = registerElement(wallLeft, 0x6c6c75);
    wallsByStorey[storey].push(elFront, elBack, elRight, elLeft);
    externalByStorey[storey].outer.push(elFront, elRight);
    externalByStorey[storey].inner.push(elBack, elLeft);

    // FRONT-face windows. Storey 0 has 2 windows flanking the centre door;
    // storey 1 has 3 evenly spaced (no door above to dodge). Generous
    // spacing so nothing overlaps even at WALL_THK + offsets.
    const winY = yMid + 0.55; // sill ~yMid+0.05, head ~yMid+1.05
    const frontXs = storey === 0 ? [-3.2, +3.2] : [-3.2, 0, +3.2];
    for (const x of frontXs) {
      const win = makeMesh(new THREE.BoxGeometry(1.0, 1.1, WALL_THK + 0.02), 0x2c3a52);
      win.position.set(x, winY, FRONT_Z);
      root.add(win);
      windowsByStorey[storey].push(registerElement(win, 0x2c3a52));
    }

    // BACK-face windows: 3 per storey, evenly spaced (visible while the
    // camera auto-orbits past the rear).
    for (const x of [-3.2, 0, +3.2]) {
      const win = makeMesh(new THREE.BoxGeometry(1.0, 1.1, WALL_THK + 0.02), 0x2c3a52);
      win.position.set(x, winY, BACK_Z);
      root.add(win);
      windowsByStorey[storey].push(registerElement(win, 0x2c3a52));
    }

    // SIDE-face windows: 1 per storey on the LEFT face only — the RIGHT
    // face is reserved for the agent-created side door (step 8).
    const winSide = makeMesh(new THREE.BoxGeometry(WALL_THK + 0.02, 1.1, 1.0), 0x2c3a52);
    winSide.position.set(LEFT_X, winY, 0);
    root.add(winSide);
    windowsByStorey[storey].push(registerElement(winSide, 0x2c3a52));
  }

  // ORIGINAL door — front face, ground floor, dead-centre on the wall. The
  // door is taller than the windows above it, so the silhouette reads as
  // a real entrance rather than another opening.
  const door = makeMesh(new THREE.BoxGeometry(1.05, 2.2, WALL_THK + 0.04), 0x2a2a30);
  door.position.set(0, 1.1, FRONT_Z);
  root.add(door);
  doorEls.push(registerElement(door, 0x2a2a30));

  // Tiny "step" / threshold under the door so it visibly sits on the slab.
  const threshold = makeMesh(new THREE.BoxGeometry(1.4, 0.05, 0.5), 0x55554f);
  threshold.position.set(0, 0.025, FRONT_Z + 0.18);
  root.add(threshold);
  registerElement(threshold, 0x55554f);

  // NEW door — created by entity_create step. Lives on the RIGHT face (a
  // wall that started out blank), centred on Z. Hidden + lifted high by
  // default; slides down + fades in when the agent fires entity_create so
  // the addition is unmistakable.
  const newDoor = makeMesh(new THREE.BoxGeometry(WALL_THK + 0.04, 2.2, 1.05), NEW_DOOR_HUE);
  newDoor.position.set(RIGHT_X, 4.6, 0);
  root.add(newDoor);
  const newDoorEl = registerElement(newDoor, NEW_DOOR_HUE, 0);
  newDoorEl.hidden = true;
  // Threshold for the new door — also hidden until the agent acts.
  const newThreshold = makeMesh(new THREE.BoxGeometry(0.5, 0.05, 1.4), 0x55554f);
  newThreshold.position.set(RIGHT_X + 0.18, 0.025, 0);
  root.add(newThreshold);
  const newThresholdEl = registerElement(newThreshold, 0x55554f, 0);
  newThresholdEl.hidden = true;

  // Storey-2 floor (so the silhouette reads as two-storey).
  const floor2 = makeMesh(new THREE.BoxGeometry(W + 0.05, 0.08, D + 0.05), PAPER_DIM);
  floor2.position.y = STOREY;
  root.add(floor2);
  const floor2El = registerElement(floor2, PAPER_DIM);

  // Roof — true hip roof matching the 8 × 5 footprint with a small eave
  // overhang. Built as a closed mesh of two trapezoids (front/back) + two
  // triangles (left/right) meeting at a ridge along the long X axis.
  const roof = makeMesh(makeHipRoof(W, D, 1.5, 0.5), 0x4a4a52);
  roof.position.y = 2 * STOREY + 0.05;
  root.add(roof);
  const roofEl = registerElement(roof, 0x4a4a52);

  // Eave board — a thin lip along the top edge of the upper walls so the
  // roof meets the walls cleanly instead of floating.
  const eave = makeMesh(new THREE.BoxGeometry(W + 1.0, 0.08, D + 1.0), 0x3e3e44);
  eave.position.y = 2 * STOREY + 0.04;
  root.add(eave);
  registerElement(eave, 0x3e3e44);

  // ── Section plane visualisation ─────────────────────────────────────────
  // A faint chartreuse rectangle that snaps in only when the section step
  // fires, so the user sees WHERE the cut is happening.
  const sectionVis = new THREE.Mesh(
    new THREE.PlaneGeometry(W + 1.2, D + 1.2),
    new THREE.MeshBasicMaterial({
      color: ACCENT,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  sectionVis.rotation.x = -Math.PI / 2;
  sectionVis.position.y = 2.2;
  scene.add(sectionVis);

  // ── BCF pin (3D Sprite) ─────────────────────────────────────────────────
  // A small canvas-baked red disc that lives in world space on the front
  // wall, top-right area. Sprites always face the camera, so this stays
  // legible through auto-rotate. The "BCF #04" caption next to it is still
  // an HTML overlay (handled by McpLanding) but it now anchors to the
  // sprite’s projected screen position via getProjectedPin().
  const pinCanvas = document.createElement('canvas');
  pinCanvas.width = 96;
  pinCanvas.height = 96;
  const pinCtx = pinCanvas.getContext('2d');
  if (pinCtx) {
    // soft glow
    const grad = pinCtx.createRadialGradient(48, 48, 6, 48, 48, 48);
    grad.addColorStop(0, 'rgba(255, 58, 58, 0.55)');
    grad.addColorStop(0.55, 'rgba(255, 58, 58, 0.18)');
    grad.addColorStop(1, 'rgba(255, 58, 58, 0)');
    pinCtx.fillStyle = grad;
    pinCtx.fillRect(0, 0, 96, 96);
    // solid disc
    pinCtx.beginPath();
    pinCtx.arc(48, 48, 22, 0, Math.PI * 2);
    pinCtx.fillStyle = '#ff3a3a';
    pinCtx.fill();
    pinCtx.lineWidth = 2;
    pinCtx.strokeStyle = '#fff';
    pinCtx.stroke();
    // "!" glyph
    pinCtx.fillStyle = '#fff';
    pinCtx.font = 'bold 30px ui-monospace, "JetBrains Mono", Menlo, monospace';
    pinCtx.textAlign = 'center';
    pinCtx.textBaseline = 'middle';
    pinCtx.fillText('!', 48, 49);
  }
  const pinTex = new THREE.CanvasTexture(pinCanvas);
  pinTex.colorSpace = THREE.SRGBColorSpace;
  const pinMat = new THREE.SpriteMaterial({
    map: pinTex,
    transparent: true,
    opacity: 0,
    depthTest: false,
  });
  const pin = new THREE.Sprite(pinMat);
  pin.scale.set(0.9, 0.9, 1);
  // Anchor on the front wall, towards the right side (away from the door).
  // World coords map directly to model since root has no rotation.
  pin.position.set(2.6, 1.9, FRONT_Z + 0.1);
  scene.add(pin);
  let pinOpacityTarget = 0;

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

  // ── Camera tween targets ─────────────────────────────────────────────────
  // No parent rotation any more, so all targets read in plain world coords.
  // Default: front-right corner at slight elevation.
  // Close:   nudged in toward the front face for the describe-selection step.
  // RightAngle: looks at the +X (RIGHT) face where the new door appears,
  //             rotated camera around to the side so it’s visible.
  const cameraDefault = new THREE.Vector3(12, 8, 13);
  const cameraClose = new THREE.Vector3(8, 5.5, 10);
  const cameraRightAngle = new THREE.Vector3(14, 6, 6);
  let cameraTarget = cameraDefault.clone();

  // Section plane state — animates between "off" (constant 100) and "on"
  // (constant 2.2 → clipping above y=2.2).
  let sectionConstantTarget = 100;
  let sectionVisOpacityTarget = 0;

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
    sectionPlane.constant = THREE.MathUtils.lerp(sectionPlane.constant, sectionConstantTarget, 0.08);
    const sectMat = sectionVis.material as THREE.MeshBasicMaterial;
    sectMat.opacity = THREE.MathUtils.lerp(sectMat.opacity, sectionVisOpacityTarget, 0.1);

    // BCF pin sprite tween
    pinMat.opacity = THREE.MathUtils.lerp(pinMat.opacity, pinOpacityTarget, 0.12);

    camera.position.lerp(cameraTarget, 0.04);
    renderer.render(scene, camera);
  }
  tick();

  // ── State controller ────────────────────────────────────────────────────
  // Every step is its own switch case so each transition is a *complete*
  // scene description, not a cumulative diff. That's what makes the visual
  // story arc legible — Survey paints types, Layer overrides with storeys,
  // Standardize pulls everything into bSDD blue, etc. The few things that
  // genuinely persist across steps (the agent-created door once it lands;
  // the section plane while it’s active) are restored explicitly inside
  // each case that needs them.
  function setTarget(el: Element, color: number, opacity = 1) {
    el.targetColor.setHex(color);
    el.targetOpacity = opacity;
    el.hidden = false;
  }
  function dim(el: Element, opacity = 0.16) {
    el.targetOpacity = opacity;
  }
  function reset() {
    for (const el of allElements) {
      el.targetColor.copy(el.baseColor);
      el.targetOpacity = el.baseOpacity;
      if (el.baseY !== undefined) el.yOffset = 0;
    }
    cameraTarget = cameraDefault.clone();
    sectionConstantTarget = 100;
    sectionVisOpacityTarget = 0;
    newDoorEl.hidden = true;
    newThresholdEl.hidden = true;
    pinOpacityTarget = 0;
  }

  // After step 8, the new door / threshold persist into later steps. This
  // helper re-applies that state inside cases that come after entity_create.
  function keepNewDoor() {
    newDoorEl.hidden = false;
    newDoorEl.targetOpacity = 1;
    newDoorEl.targetColor.setHex(NEW_DOOR_HUE);
    newDoorEl.yOffset = -3.5;
    newThresholdEl.hidden = false;
    newThresholdEl.targetOpacity = 1;
  }

  // Type aliases for legibility inside the switch
  const allWalls = () => [...wallsByStorey[0], ...wallsByStorey[1]];
  const allWindows = () => [...windowsByStorey[0], ...windowsByStorey[1]];

  function update(step: number) {
    reset();
    switch (step) {
      // ── 00  OPEN  ───────────────────────────────────────────────────────
      // Establish neutral framing — camera sits in the front-right corner
      // and slowly orbits.
      case 0: {
        cameraTarget = cameraDefault.clone();
        break;
      }

      // ── 01  AUDIT  ──────────────────────────────────────────────────────
      // model_audit reports a single offending wall (missing FireRating).
      // Visual: the offending wall flashes a saturated red while the rest
      // of the building stays neutral.
      case 1: {
        const issueWall = externalByStorey[0].outer[0]; // front-face ground wall
        setTarget(issueWall, 0xff3a3a);
        cameraTarget = new THREE.Vector3(13, 8.5, 14);
        break;
      }

      // ── 02  SURVEY  ─────────────────────────────────────────────────────
      // count_entities groups by type. Visual: each type takes its own
      // distinct hue at the same time so the histogram in the overlay
      // maps onto the building. Pulls camera up so slabs + roof read.
      case 2: {
        for (const el of allWalls()) setTarget(el, 0x73daca);          // walls — teal
        for (const el of allWindows()) setTarget(el, 0x7aa2f7);        // windows — blue
        for (const el of doorEls) setTarget(el, 0xff9e64);             // doors — orange
        setTarget(slabEl, 0xbb9af7);                                   // slabs — purple
        setTarget(floor2El, 0xbb9af7);
        setTarget(roofEl, 0xc8c8d0);                                   // roof — pale
        cameraTarget = new THREE.Vector3(11, 11, 13);
        break;
      }

      // ── 03  LAYER  ──────────────────────────────────────────────────────
      // viewer_color_by_storey — ground floor cool blue, upper warm orange.
      case 3: {
        for (const el of wallsByStorey[0]) setTarget(el, STOREY_HUE_LO);
        for (const el of wallsByStorey[1]) setTarget(el, STOREY_HUE_HI);
        cameraTarget = cameraDefault.clone();
        break;
      }

      // ── 04  CLASSIFY  ───────────────────────────────────────────────────
      // viewer_color_by_property("IsExternal") — outer (front + right)
      // walls go chartreuse, inner walls go cool lavender.
      case 4: {
        for (const s of [0, 1]) {
          for (const el of externalByStorey[s].outer) setTarget(el, PROP_TRUE);
          for (const el of externalByStorey[s].inner) setTarget(el, PROP_FALSE);
        }
        cameraTarget = new THREE.Vector3(13, 7, 11);
        break;
      }

      // ── 05  FOCUS  ──────────────────────────────────────────────────────
      // viewer_isolate — pick ONE specific wall (front face, ground storey
      // — the wall the door sits on) and dim absolutely everything else
      // to ~2 %. Camera dollies in close to a near-elevation view so the
      // single wall reads at full size.
      case 5: {
        const pickedWall = wallsByStorey[0][0]; // FRONT, storey 0
        for (const el of allElements) {
          if (el === pickedWall) continue;
          el.targetOpacity = 0.02;
        }
        setTarget(pickedWall, 0x6c6c75); // neutral grey — Paint step pops next
        cameraTarget = new THREE.Vector3(4, 3.5, 10);
        break;
      }

      // ── 06  PAINT  ──────────────────────────────────────────────────────
      // viewer_colorize per-entity — every visible IFC element gets a
      // distinct hue from the palette. The agent fanning out colours per
      // entity makes the "we touched everything" point loud + clear.
      case 6: {
        // Bring everything back from Focus first.
        for (const el of allElements) {
          el.targetOpacity = el.baseOpacity;
        }
        // Newly-created door doesn’t exist yet — keep it hidden until step 8.
        newDoorEl.hidden = true;
        newThresholdEl.hidden = true;

        // Group + walk the palette. Each group cycles independently so
        // we don’t end up with two adjacent walls in the same colour.
        const RAINBOW = [
          0xff3a3a, 0xff9e64, 0xe0af68, 0xd6ff3f,
          0x9ece6a, 0x73daca, 0x7aa2f7, 0xbb9af7, 0xff5cdc,
        ];
        let i = 0;
        for (const el of allWalls()) setTarget(el, RAINBOW[i++ % RAINBOW.length]);
        for (const el of allWindows()) setTarget(el, RAINBOW[i++ % RAINBOW.length]);
        for (const el of doorEls) setTarget(el, RAINBOW[i++ % RAINBOW.length]);
        setTarget(slabEl, RAINBOW[i++ % RAINBOW.length]);
        setTarget(floor2El, RAINBOW[i++ % RAINBOW.length]);
        setTarget(roofEl, RAINBOW[i++ % RAINBOW.length]);
        cameraTarget = new THREE.Vector3(11, 7, 12);
        break;
      }

      // ── 07  STANDARDIZE  (bSDD) ────────────────────────────────────────
      // bsdd_property_sets — walls take the deep "schema blue" cue, still
      // isolated, with the data sheet overlay showing the canonical Pset.
      case 7: {
        dim(roofEl, 0.0);
        dim(slabEl, 0.04);
        dim(floor2El, 0.04);
        for (const el of allWindows()) dim(el, 0.02);
        for (const el of doorEls) dim(el, 0.02);
        for (const el of allWalls()) setTarget(el, 0x2e5fc7);
        cameraTarget = new THREE.Vector3(9, 5, 10);
        break;
      }

      // ── 08  ADD  ────────────────────────────────────────────────────────
      // entity_create(IfcDoor) — reveal the new door on the +X face,
      // restore non-wall opacities so the building reads in context, swing
      // the camera over so the addition is unmistakable.
      case 8: {
        for (const el of allWindows()) {
          el.targetOpacity = 1;
          el.targetColor.setHex(0x2c3a52);
        }
        for (const el of doorEls) {
          el.targetOpacity = 1;
          el.targetColor.setHex(0x2a2a30);
        }
        slabEl.targetOpacity = 1;
        floor2El.targetOpacity = 1;
        roofEl.targetOpacity = 1;
        for (const el of allWalls()) {
          el.targetOpacity = 1;
          el.targetColor.setHex(0x6c6c75);
        }
        keepNewDoor();
        cameraTarget = cameraRightAngle.clone();
        break;
      }

      // ── 09  SECTION  ────────────────────────────────────────────────────
      // viewer_set_section(z=2.2) — clip the upper storey progressively;
      // a chartreuse plane rectangle marks where the cut is. Camera drops
      // low so the section reads as a horizontal slice.
      case 9: {
        keepNewDoor();
        sectionConstantTarget = 2.2;
        sectionVisOpacityTarget = 0.22;
        cameraTarget = new THREE.Vector3(10, 4, 12);
        break;
      }

      // ── 10  ISSUE  (BCF)  ──────────────────────────────────────────────
      // bcf_topic_create — the 3D pin sprite (anchored to the front wall
      // top-right) fades in. The wall the pin sits on flashes red so the
      // anchor is unambiguous. Section stays clipped to keep the lower
      // storey reading.
      case 10: {
        keepNewDoor();
        sectionConstantTarget = 2.2;
        sectionVisOpacityTarget = 0.14;
        const issueWall = externalByStorey[0].outer[0]; // FRONT wall
        for (const el of allWalls()) dim(el, 0.45);
        setTarget(issueWall, 0xff3a3a, 1);
        pinOpacityTarget = 1;
        cameraTarget = new THREE.Vector3(9.5, 4, 10);
        break;
      }

      // ── 11  INSPECT  ────────────────────────────────────────────────────
      // viewer_describe_selection — clear section, dim the building down,
      // light up the picked wall in magenta. The describe-card overlay
      // does the rest.
      case 11: {
        keepNewDoor();
        sectionConstantTarget = 100;
        sectionVisOpacityTarget = 0;
        const pickedEl = externalByStorey[0].outer[0];
        for (const el of allWalls()) dim(el, 0.18);
        for (const el of allWindows()) dim(el, 0.5);
        setTarget(pickedEl, ACCENT_2, 1);
        cameraTarget = cameraClose.clone();
        break;
      }

      default: {
        cameraTarget = cameraDefault.clone();
      }
    }
  }

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

// ── geometry helpers ──────────────────────────────────────────────────────

/**
 * Build a hip-roof BufferGeometry for a rectangular footprint W × D with a
 * given peak `height` and `overhang` past the eaves. The ridge runs along
 * the long axis (X). All faces are non-indexed so per-face normals shade
 * cleanly without averaging across the ridge.
 */
function makeHipRoof(W: number, D: number, height: number, overhang: number): THREE.BufferGeometry {
  const hx = W / 2 + overhang;
  const hz = D / 2 + overhang;
  // 45° hips on the short ends → the ridge is hz inset from each X edge.
  const ridgeX = Math.max(0, hx - hz);

  // Eave corners (y = 0) and the two ridge endpoints (y = height).
  const FL: [number, number, number] = [-hx, 0, hz];   // front-left
  const FR: [number, number, number] = [hx, 0, hz];    // front-right
  const BR: [number, number, number] = [hx, 0, -hz];   // back-right
  const BL: [number, number, number] = [-hx, 0, -hz];  // back-left
  const RL: [number, number, number] = [-ridgeX, height, 0]; // ridge-left
  const RR: [number, number, number] = [ridgeX, height, 0];  // ridge-right

  const positions: number[] = [];
  function tri(a: [number, number, number], b: [number, number, number], c: [number, number, number]) {
    positions.push(...a, ...b, ...c);
  }
  function quad(a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]) {
    tri(a, b, c);
    tri(a, c, d);
  }

  // Vertex order is CCW when viewed from outside the roof. Three.js will
  // recompute normals after we set positions.
  // Front (looking from +Z): FL → FR → RR → RL
  quad(FL, FR, RR, RL);
  // Right end (looking from +X): FR → BR → RR (triangle)
  tri(FR, BR, RR);
  // Back (looking from -Z): BR → BL → RL → RR
  quad(BR, BL, RL, RR);
  // Left end (looking from -X): BL → FL → RL (triangle)
  tri(BL, FL, RL);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}
