/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical names for the `ifc-lite:*` window events tours consume or emit.
 * One name per signal - tour steps and emitters must both import from here
 * so the two sides can never drift.
 */

/**
 * Fired (throttled) when the user genuinely moves the camera: orbit or pan
 * drag, wheel zoom, or a ViewCube interaction. Emitted from the real gesture
 * sites - NOT from `onCameraRotationChange`, whose single callback slot is
 * owned by the ViewCube and which re-fires on an idle animation-loop tick.
 * detail: { kind: 'orbit' | 'pan' | 'zoom' | 'preset' }
 */
export const EVENT_CAMERA_INTERACTED = 'ifc-lite:camera-interacted';

/**
 * Fired after a file the user asked for was handed to the browser for
 * download (export IFC/GLB/CSV, BCF, screenshots, script CSVs). Emitted from
 * the shared download choke point so every export path counts.
 * detail: { kind: string }
 */
export const EVENT_FILE_DOWNLOADED = 'ifc-lite:file-downloaded';

/**
 * Add a model to the CURRENT federation set (detail: File) - unlike
 * `ifc-lite:load-file`, which replaces the loaded model. Listener lives in
 * MainToolbar next to the load-file one; used by the compare tour to bring
 * in the demo revision B.
 */
export const EVENT_ADD_MODEL = 'ifc-lite:add-model';

/** Existing bus events tours reuse (listeners live in the viewer today). */
export const EVENT_LOAD_FILE = 'ifc-lite:load-file';
export const EVENT_SHOW_SHORTCUTS = 'ifc-lite:show-shortcuts';
export const EVENT_OPEN_COMMAND_PALETTE = 'ifc-lite:open-command-palette';

export type CameraGestureKind = 'orbit' | 'pan' | 'zoom' | 'preset';

/** Emit helpers keep both sides of a signal on the same name and shape. */
export function emitCameraInteracted(kind: CameraGestureKind): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_CAMERA_INTERACTED, { detail: { kind } }));
}

export function emitFileDownloaded(filename: string): void {
  if (typeof window === 'undefined') return;
  const kind = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : 'file';
  window.dispatchEvent(new CustomEvent(EVENT_FILE_DOWNLOADED, { detail: { kind } }));
}
