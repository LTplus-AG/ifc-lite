/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Transactional, source-ordered publication for preflighted LandXML meshes. */

import type { MeshData } from '@ifc-lite/geometry';
import type { LandXmlRenderFramePlan } from './landXmlRenderFrame.js';

export interface LandXmlFederationReservation {
  reserveModel(modelId: string, maxExpressId: number): number;
  publishRange(modelId: string, start: number, end: number): void;
  unregisterModel(modelId: string): void;
}

export interface LandXmlProvisionalResources {
  publish(mesh: MeshData): void;
  remove(globalExpressIds: readonly number[]): void;
}

/**
 * Reserves every local ID before the first pickable GPU publication. A failed
 * resource upload is rolled back before it can leave a partially-owned global
 * range visible to selection/federation consumers.
 */
export class LandXmlProvisionalTransaction {
  readonly idOffset: number;
  private readonly published: number[] = [];
  private nextLocalId = 1;
  private committed = false;
  private rolledBack = false;

  constructor(
    private readonly modelId: string,
    readonly reservedMaxExpressId: number,
    readonly frame: LandXmlRenderFramePlan,
    private readonly registry: LandXmlFederationReservation,
    private readonly resources: LandXmlProvisionalResources,
  ) {
    if (!Number.isInteger(reservedMaxExpressId) || reservedMaxExpressId < 0) {
      throw new Error('LandXML preflight produced an invalid local-ID envelope');
    }
    this.idOffset = registry.reserveModel(modelId, reservedMaxExpressId);
  }

  /** Publish exactly the next preflighted local component in source order. */
  publish(mesh: MeshData): number {
    this.ensureOpen();
    const localId = this.nextLocalId;
    if (localId > this.reservedMaxExpressId) {
      throw new Error('LandXML second pass exceeded its preflight ID envelope');
    }
    if (mesh.expressId !== localId) {
      throw new Error('LandXML second pass violated preflight component ordering');
    }
    const globalId = localId + this.idOffset;
    const globalMesh = { ...mesh, expressId: globalId };
    try {
      this.registry.publishRange(this.modelId, localId, localId);
      this.resources.publish(globalMesh);
      this.published.push(globalId);
      this.nextLocalId++;
      return globalId;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  /**
   * Consume a source-ordered component which the frozen destination frame
   * rejected.  It still becomes an owned (but intentionally unmeshed) local
   * id so later components retain their preflight identities.
   */
  skip(mesh: Pick<MeshData, 'expressId'>): void {
    this.ensureOpen();
    const localId = this.nextLocalId;
    if (localId > this.reservedMaxExpressId) {
      throw new Error('LandXML second pass exceeded its preflight ID envelope');
    }
    if (mesh.expressId !== localId) {
      throw new Error('LandXML second pass violated preflight component ordering');
    }
    try {
      this.registry.publishRange(this.modelId, localId, localId);
      this.nextLocalId++;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  /** The second pass must reproduce the exact preflight component count. */
  commit(): void {
    this.ensureOpen();
    if (this.nextLocalId - 1 !== this.reservedMaxExpressId) {
      this.rollback();
      throw new Error('LandXML second pass did not reproduce its preflight ID envelope');
    }
    this.committed = true;
  }

  rollback(): void {
    if (this.rolledBack) return;
    this.rolledBack = true;
    try {
      if (this.published.length > 0) this.resources.remove(this.published);
    } finally {
      this.registry.unregisterModel(this.modelId);
    }
  }

  private ensureOpen(): void {
    if (this.committed || this.rolledBack) throw new Error('LandXML provisional transaction is closed');
  }
}
