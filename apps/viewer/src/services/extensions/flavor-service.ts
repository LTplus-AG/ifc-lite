/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlavorService` — viewer-side façade for the flavor library.
 *
 * Wraps `InMemoryFlavorStorage` for now; the IDB-backed adapter lands
 * with the persistence pass (P3.T17 — safe-mode launch). The service
 * owns the active-flavor pointer, list/CRUD, switch logic, and
 * snapshot management.
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md.
 */

import {
  InMemoryFlavorStorage,
  packFlavor,
  switchFlavor,
  unpackFlavor,
  validateFlavor,
  type Flavor,
  type FlavorExtensionState,
  type FlavorStorage,
  type FlavorSwitcherCallbacks,
  type FlavorSwitchResult,
  type UnpackedFlavor,
} from '@ifc-lite/extensions';

export interface FlavorServiceOptions {
  storage?: FlavorStorage;
}

export class FlavorService {
  private readonly storage: FlavorStorage;
  private listeners = new Set<() => void>();

  constructor(opts: FlavorServiceOptions = {}) {
    this.storage = opts.storage ?? new InMemoryFlavorStorage();
  }

  async list(): Promise<Flavor[]> {
    return this.storage.listFlavors();
  }

  async getActive(): Promise<Flavor | undefined> {
    const id = await this.storage.getActiveId();
    return id ? this.storage.getFlavor(id) : undefined;
  }

  async put(flavor: Flavor, reason?: string): Promise<void> {
    await this.storage.putFlavor(flavor, reason);
    this.emit();
  }

  async delete(id: string): Promise<void> {
    await this.storage.deleteFlavor(id);
    this.emit();
  }

  async activate(id: string | undefined): Promise<void> {
    await this.storage.setActiveId(id);
    this.emit();
  }

  /**
   * Switch to a target flavor, enabling its extension list and
   * disabling anything the prior flavor had that this one doesn't.
   * Callers wire the `callbacks` to their extension loader/runtime.
   */
  async switchTo(
    target: Flavor,
    installed: readonly FlavorExtensionState[],
    callbacks: FlavorSwitcherCallbacks,
  ): Promise<FlavorSwitchResult> {
    const current = await this.getActive();
    const result = await switchFlavor({
      target,
      installed,
      current,
      callbacks,
    });
    if (result.ok) this.emit();
    return result;
  }

  /** Serialise the active (or named) flavor to a `.iflv` byte array. */
  async exportFlavor(id?: string, summary?: string): Promise<Uint8Array> {
    const flavorId = id ?? (await this.storage.getActiveId());
    if (!flavorId) throw new Error('No active flavor to export.');
    const flavor = await this.storage.getFlavor(flavorId);
    if (!flavor) throw new Error(`Unknown flavor: ${flavorId}`);
    return packFlavor(flavor, { summary });
  }

  /** Parse + validate a `.iflv` byte array. Does NOT install. */
  async preview(bytes: Uint8Array): Promise<UnpackedFlavor> {
    const result = unpackFlavor(bytes);
    if (!result.ok) {
      throw new Error(
        `Flavor did not unpack: ${result.errors[0]?.message ?? 'unknown error'}`,
      );
    }
    return result.value;
  }

  /** Save a previewed flavor, optionally as a new id. */
  async importFlavor(
    unpacked: UnpackedFlavor,
    opts: { strategy?: 'replace' | 'save-as-new'; newId?: string } = {},
  ): Promise<Flavor> {
    const validated = validateFlavor(unpacked.flavor);
    if (!validated.ok) {
      throw new Error(
        `Imported flavor did not validate: ${validated.errors[0]?.message ?? 'unknown'}`,
      );
    }
    let flavor = validated.value;
    if (opts.strategy === 'save-as-new') {
      flavor = {
        ...flavor,
        id: opts.newId ?? `${flavor.id}.imported-${Date.now()}`,
        updatedAt: new Date().toISOString(),
      };
    }
    await this.storage.putFlavor(flavor, 'imported');
    this.emit();
    return flavor;
  }

  /** Reset to a clean baseline flavor. */
  async resetToDefaults(): Promise<Flavor> {
    const id = 'flv.default';
    const now = new Date().toISOString();
    const flavor: Flavor = {
      schemaVersion: 1,
      id,
      name: 'Default',
      description: 'Baseline flavor — no extensions, no overrides.',
      createdAt: now,
      updatedAt: now,
      extensions: [],
      lenses: [],
      savedQueries: [],
      keybindings: [],
      layout: { state: {} },
      settings: {},
    };
    await this.storage.putFlavor(flavor, 'reset to defaults');
    await this.storage.setActiveId(id);
    this.emit();
    return flavor;
  }

  /** Subscribe to flavor changes. Returns unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
