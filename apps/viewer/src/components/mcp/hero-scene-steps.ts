/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hero's twelve-step story arc: what each `HERO_STEPS` entry does to the
 * building.
 *
 * Every step is its own switch case so each transition is a *complete*
 * scene description, not a cumulative diff. That's what makes the visual
 * story arc legible — Survey paints types, Layer overrides with storeys,
 * Standardize pulls everything into bSDD blue, etc. The few things that
 * genuinely persist across steps (the agent-created door once it lands;
 * the section plane while it’s active) are restored explicitly inside
 * each case that needs them.
 *
 * Nothing is applied directly: cases set *targets* on the elements and on
 * `HeroAnimationState`, and `hero-scene.ts`'s rAF loop lerps towards them.
 */

import * as THREE from 'three';
import {
  ACCENT_2,
  NEW_DOOR_HUE,
  PROP_FALSE,
  PROP_TRUE,
  STOREY_HUE_HI,
  STOREY_HUE_LO,
  type Element,
  type HeroBuilding,
} from './hero-scene-building';

// ── Camera tween targets ─────────────────────────────────────────────────
// No parent rotation any more, so all targets read in plain world coords.
// Default: front-right corner at slight elevation.
// Close:   nudged in toward the front face for the describe-selection step.
// RightAngle: looks at the +X (RIGHT) face where the new door appears,
//             rotated camera around to the side so it’s visible.
const cameraDefault = new THREE.Vector3(12, 8, 13);
const cameraClose = new THREE.Vector3(8, 5.5, 10);
const cameraRightAngle = new THREE.Vector3(14, 6, 6);

/**
 * The scalar targets the animation loop lerps towards. Held in one mutable
 * object so the step controller and the loop share them without either owning
 * the other.
 */
export interface HeroAnimationState {
  cameraTarget: THREE.Vector3;
  /** Section plane state — 100 is "off", 2.2 clips above y=2.2. */
  sectionConstantTarget: number;
  sectionVisOpacityTarget: number;
  pinOpacityTarget: number;
}

export function createHeroAnimationState(): HeroAnimationState {
  return {
    cameraTarget: cameraDefault.clone(),
    sectionConstantTarget: 100,
    sectionVisOpacityTarget: 0,
    pinOpacityTarget: 0,
  };
}

/** Build the `update(step)` function that drives the arc. */
export function createStepController(
  building: HeroBuilding,
  state: HeroAnimationState,
): (step: number) => void {
  const {
    allElements,
    wallsByStorey,
    externalByStorey,
    windowsByStorey,
    doorEls,
    slabEl,
    floor2El,
    roofEl,
    newDoorEl,
    newThresholdEl,
  } = building;

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
    state.cameraTarget = cameraDefault.clone();
    state.sectionConstantTarget = 100;
    state.sectionVisOpacityTarget = 0;
    newDoorEl.hidden = true;
    newThresholdEl.hidden = true;
    state.pinOpacityTarget = 0;
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

  return function update(step: number) {
    reset();
    switch (step) {
      // ── 00  OPEN  ───────────────────────────────────────────────────────
      // Establish neutral framing — camera sits in the front-right corner
      // and slowly orbits.
      case 0: {
        state.cameraTarget = cameraDefault.clone();
        break;
      }

      // ── 01  AUDIT  ──────────────────────────────────────────────────────
      // model_audit reports a single offending wall (missing FireRating).
      // Visual: the offending wall flashes a saturated red while the rest
      // of the building stays neutral.
      case 1: {
        const issueWall = externalByStorey[0].outer[0]; // front-face ground wall
        setTarget(issueWall, 0xff3a3a);
        state.cameraTarget = new THREE.Vector3(13, 8.5, 14);
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
        state.cameraTarget = new THREE.Vector3(11, 11, 13);
        break;
      }

      // ── 03  LAYER  ──────────────────────────────────────────────────────
      // viewer_color_by_storey — ground floor cool blue, upper warm orange.
      case 3: {
        for (const el of wallsByStorey[0]) setTarget(el, STOREY_HUE_LO);
        for (const el of wallsByStorey[1]) setTarget(el, STOREY_HUE_HI);
        state.cameraTarget = cameraDefault.clone();
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
        state.cameraTarget = new THREE.Vector3(13, 7, 11);
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
        state.cameraTarget = new THREE.Vector3(4, 3.5, 10);
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
        state.cameraTarget = new THREE.Vector3(11, 7, 12);
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
        state.cameraTarget = new THREE.Vector3(9, 5, 10);
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
        state.cameraTarget = cameraRightAngle.clone();
        break;
      }

      // ── 09  SECTION  ────────────────────────────────────────────────────
      // viewer_set_section(z=2.2) — clip the upper storey progressively;
      // a chartreuse plane rectangle marks where the cut is. Camera drops
      // low so the section reads as a horizontal slice.
      case 9: {
        keepNewDoor();
        state.sectionConstantTarget = 2.2;
        state.sectionVisOpacityTarget = 0.22;
        state.cameraTarget = new THREE.Vector3(10, 4, 12);
        break;
      }

      // ── 10  ISSUE  (BCF)  ──────────────────────────────────────────────
      // bcf_topic_create — the 3D pin sprite (anchored to the front wall
      // top-right) fades in. The wall the pin sits on flashes red so the
      // anchor is unambiguous. Section stays clipped to keep the lower
      // storey reading.
      case 10: {
        keepNewDoor();
        state.sectionConstantTarget = 2.2;
        state.sectionVisOpacityTarget = 0.14;
        const issueWall = externalByStorey[0].outer[0]; // FRONT wall
        for (const el of allWalls()) dim(el, 0.45);
        setTarget(issueWall, 0xff3a3a, 1);
        state.pinOpacityTarget = 1;
        state.cameraTarget = new THREE.Vector3(9.5, 4, 10);
        break;
      }

      // ── 11  INSPECT  ────────────────────────────────────────────────────
      // viewer_describe_selection — clear section, dim the building down,
      // light up the picked wall in magenta. The describe-card overlay
      // does the rest.
      case 11: {
        keepNewDoor();
        state.sectionConstantTarget = 100;
        state.sectionVisOpacityTarget = 0;
        const pickedEl = externalByStorey[0].outer[0];
        for (const el of allWalls()) dim(el, 0.18);
        for (const el of allWindows()) dim(el, 0.5);
        setTarget(pickedEl, ACCENT_2, 1);
        state.cameraTarget = cameraClose.clone();
        break;
      }

      default: {
        state.cameraTarget = cameraDefault.clone();
      }
    }
  };
}
