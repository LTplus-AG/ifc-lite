/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hero building's geometry: walls, windows, doors, slabs, roof, plus the
 * two props the step choreography animates (the section-plane rectangle and
 * the BCF pin sprite).
 *
 * Built once per mount and handed to `hero-scene.ts` (which owns the renderer
 * and the animation loop) and `hero-scene-steps.ts` (which owns the twelve-step
 * story arc). Nothing here animates — every element is registered with a base
 * colour/opacity that the step controller then retargets.
 */

import * as THREE from 'three';

const PAPER = 0xede4d3;
const PAPER_DIM = 0x6f6657;
const TEAL = 0x73daca;
const SLAB_DIM = 0x222226;

export const ACCENT = 0xd6ff3f;     // chartreuse
export const ACCENT_2 = 0xff5cdc;   // magenta
export const STOREY_HUE_LO = 0x4a6fa5; // cool blue
export const STOREY_HUE_HI = 0xff9e64; // warm orange
export const PROP_TRUE = 0xd6ff3f;     // outer (IsExternal=true)
export const PROP_FALSE = 0x7c7cd2;    // inner (IsExternal=false)
export const NEW_DOOR_HUE = 0xff5cdc;  // freshly-created door pulses magenta

export const STOREY = 3;       // storey height

export interface Element {
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

/** Everything the animation loop and the step controller address by name. */
export interface HeroBuilding {
  allElements: Element[];
  sectionPlane: THREE.Plane;
  sectionVis: THREE.Mesh;
  pin: THREE.Sprite;
  pinTex: THREE.CanvasTexture;
  pinMat: THREE.SpriteMaterial;
  wallsByStorey: Element[][];
  externalByStorey: { outer: Element[]; inner: Element[] }[];
  windowsByStorey: Element[][];
  doorEls: Element[];
  slabEl: Element;
  floor2El: Element;
  roofEl: Element;
  newDoorEl: Element;
  newThresholdEl: Element;
}

export function buildHeroBuilding(scene: THREE.Scene): HeroBuilding {
  const allElements: Element[] = [];

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

  return {
    allElements,
    sectionPlane,
    sectionVis,
    pin,
    pinTex,
    pinMat,
    wallsByStorey,
    externalByStorey,
    windowsByStorey,
    doorEls,
    slabEl,
    floor2El,
    roofEl,
    newDoorEl,
    newThresholdEl,
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
