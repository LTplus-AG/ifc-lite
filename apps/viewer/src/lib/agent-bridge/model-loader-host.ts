/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The mounted file commands' loaders, for `viewer_open_model`. The window bus
 * events they also listen to are fire-and-forget; an agent needs the load's
 * own promise to know when it finished and whether it failed.
 */

export interface AgentModelLoader {
  /** Replace the loaded models (`useIfcLoader.loadFile`) as model `modelId`; `onError` says why this load failed. */
  loadFile(file: File, modelId: string, onError: (message: string) => void): Promise<void>;
  /** Federate with the loaded models; the new model id, or null when it failed (`onError` says why, for this add only). */
  addModel(file: File, onError: (message: string) => void): Promise<string | null>;
  /** Replace the loaded models with a composed .ifcx layer stack. */
  loadStack(files: File[]): Promise<void>;
}

let current: AgentModelLoader | null = null;

/** Replacements own their own cleanup; an old owner cannot unregister a new one. */
export function registerAgentModelLoader(loader: AgentModelLoader): () => void {
  current = loader;
  return () => { if (current === loader) current = null; };
}

export function getAgentModelLoader(): AgentModelLoader | null { return current; }
