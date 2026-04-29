/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Physics state slice.
 *
 * Owns the right-side physics panel: visibility, the most recent simulation
 * result, the entity that was removed to produce it, the in-flight flag,
 * and user-tunable simulation defaults. The simulation engine itself lives
 * in `@ifc-lite/physics`; this slice is the UI's source of truth.
 */

import type { StateCreator } from 'zustand';
import type {
  EntityRef,
  PhysicsColliderStrategy,
  PhysicsSimulationResult,
} from '@ifc-lite/sdk';

export interface PhysicsPanelSettings {
  durationSeconds: number;
  fallThreshold: number;
  tiltThreshold: number;
  adjacencyTolerance: number;
  colliderStrategy: PhysicsColliderStrategy;
  /** When true, the simulator prints diagnostics to the browser console. */
  debug: boolean;
}

export interface PhysicsRemovedTarget {
  ref: EntityRef;
  name: string;
  ifcType: string;
}

export interface PhysicsPlaybackState {
  /** True while the timeline is auto-advancing. */
  isPlaying: boolean;
  /** Current playback frame index (0..frameCount-1). */
  frame: number;
  /** Wall-clock multiplier (1 = real time). */
  speed: number;
  /** Loop the animation when it reaches the last frame. */
  loop: boolean;
}

export interface PhysicsSliceState {
  /** Right-panel visibility — same convention as bcfPanelVisible. */
  physicsPanelVisible: boolean;
  /** True while a simulation is running. */
  physicsRunning: boolean;
  /** Latest result, or null when none has run / it was cleared. */
  physicsResult: PhysicsSimulationResult | null;
  /** Entity removed to produce the latest result. */
  physicsRemoved: PhysicsRemovedTarget | null;
  /** User-tunable simulation knobs. */
  physicsSettings: PhysicsPanelSettings;
  /** Animation playback state for the latest result's trajectory. */
  physicsPlayback: PhysicsPlaybackState;
  /**
   * EntityRefs the physics panel currently has tinted in the viewer.
   * Tracked so resetting only clears physics tints — lens / IDS /
   * BCF overlays painting other entities aren't clobbered.
   */
  physicsPaintedRefs: EntityRef[];
}

export interface PhysicsSlice extends PhysicsSliceState {
  setPhysicsPanelVisible: (visible: boolean) => void;
  togglePhysicsPanel: () => void;
  setPhysicsRunning: (running: boolean) => void;
  setPhysicsResult: (
    result: PhysicsSimulationResult,
    removed: PhysicsRemovedTarget | null,
  ) => void;
  clearPhysicsResult: () => void;
  updatePhysicsSettings: (patch: Partial<PhysicsPanelSettings>) => void;
  setPhysicsPlayback: (patch: Partial<PhysicsPlaybackState>) => void;
  setPhysicsPaintedRefs: (refs: EntityRef[]) => void;
}

const PLAYBACK_DEFAULT: PhysicsPlaybackState = {
  isPlaying: false,
  frame: 0,
  speed: 1,
  loop: false,
};

export const PHYSICS_DEFAULT_SETTINGS: PhysicsPanelSettings = {
  durationSeconds: 1.5,
  fallThreshold: 0.2,
  tiltThreshold: 0.05,
  adjacencyTolerance: 0.05,
  colliderStrategy: 'auto',
  debug: false,
};

export const createPhysicsSlice: StateCreator<PhysicsSlice, [], [], PhysicsSlice> = (set) => ({
  physicsPanelVisible: false,
  physicsRunning: false,
  physicsResult: null,
  physicsRemoved: null,
  physicsSettings: { ...PHYSICS_DEFAULT_SETTINGS },
  physicsPlayback: { ...PLAYBACK_DEFAULT },
  physicsPaintedRefs: [],

  setPhysicsPanelVisible: (physicsPanelVisible) => set({ physicsPanelVisible }),
  togglePhysicsPanel: () =>
    set((state) => ({ physicsPanelVisible: !state.physicsPanelVisible })),
  setPhysicsRunning: (physicsRunning) => set({ physicsRunning }),
  setPhysicsResult: (physicsResult, physicsRemoved) =>
    set({
      physicsResult,
      physicsRemoved,
      physicsRunning: false,
      // Reset to the start of the new trajectory; if the user already had
      // playback running, the RAF driver will pick the new frame up.
      physicsPlayback: { ...PLAYBACK_DEFAULT },
    }),
  clearPhysicsResult: () =>
    set({
      physicsResult: null,
      physicsRemoved: null,
      physicsRunning: false,
      physicsPlayback: { ...PLAYBACK_DEFAULT },
      physicsPaintedRefs: [],
    }),
  updatePhysicsSettings: (patch) =>
    set((state) => ({ physicsSettings: { ...state.physicsSettings, ...patch } })),
  setPhysicsPlayback: (patch) =>
    set((state) => ({ physicsPlayback: { ...state.physicsPlayback, ...patch } })),
  setPhysicsPaintedRefs: (physicsPaintedRefs) => set({ physicsPaintedRefs }),
});
