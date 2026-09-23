/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Awaited, bounded LandXML cursor orchestration shared by worker and local realms. */

import type { CoordinateInfo, ModelSpatialReference } from '@ifc-lite/geometry';
import {
  buildLandXmlSurfaceComponents, type LandXmlGeometryPreflight, type LandXmlStreamedComponent,
  type LandXmlStreamedSkippedComponent, type LandXmlStreamedSurfaceDiagnostics, type LandXmlTinDocument,
} from './landXmlIngest.js';
import { streamLandXmlSourceBlobWithApi, type LandXmlCursorApi } from './landXmlBlobCursor.js';
import { placeComponentsInKnownRenderFrame } from './landXmlRenderFrame.js';
import { LandXmlStreamPreflightReducer, type LandXmlPreflightComponent } from './landXmlStreamPreflight.js';
import { spatialMetadataFromLandXml, spatialReferenceFromSourceMetadata } from './sourceSpatialReference.js';
import { readLandXmlTinSurface } from './landXmlWasm.js';

export interface LandXmlBlobStreamSink {
  onProgress?(loadedBytes: number, totalBytes: number): void;
  onPreflight(
    preflight: LandXmlGeometryPreflight,
    sourceCoordinateInfo: CoordinateInfo,
    spatialReference?: ModelSpatialReference,
  ): boolean | Promise<boolean>;
  onPreflightComponent?(component: LandXmlPreflightComponent): void | Promise<void>;
  onPreflightComplete?(): void | Promise<void>;
  onFederatedAdmissionComponent?(component: LandXmlPreflightComponent): void | Promise<void>;
  onFederatedAdmissionComplete?(): void | Promise<void>;
  onComponent(component: LandXmlStreamedComponent): void | Promise<void>;
  onSkippedComponent(component: LandXmlStreamedSkippedComponent): void | Promise<void>;
  onSurfaceDiagnostics(component: LandXmlStreamedSurfaceDiagnostics): void | Promise<void>;
  onSourceEvent(event: unknown): void | Promise<void>;
}

export interface LandXmlBlobStreamResult {
  readonly preflight: LandXmlGeometryPreflight;
  readonly droppedPrimaryComponents: number;
  readonly federatedStreaming: boolean;
}

export interface LandXmlBlobStreamOptions {
  isCurrent?(): boolean;
  /** A federated callback may still decline after the exact first-pass envelope is known. */
  wantsFederatedStreaming: boolean;
  /**
   * #5175: forwarded verbatim to every credited cursor pass below. Absent by
   * default, so a source with no declared `<Units>` refuses exactly as it did
   * before this option existed — this is the retry value a caller supplies
   * only after the viewer surfaced that refusal to the user.
   */
  assumedLinearUnit?: string;
}

function streamUnits(header: unknown): NonNullable<LandXmlTinDocument['units']> | null {
  if (typeof header !== 'object' || header === null) throw new Error('LandXML stream emitted an invalid header');
  const units = (header as { units?: unknown }).units;
  if (units === undefined || units === null) return null;
  if (typeof units !== 'object') throw new Error('LandXML stream header has invalid Units');
  const raw = units as {
    linear_unit?: unknown;
    elevation_unit?: unknown;
    linear_scale_to_meters?: unknown;
    elevation_scale_to_meters?: unknown;
    assumed?: unknown;
  };
  if (typeof raw.linear_unit !== 'string' || typeof raw.elevation_unit !== 'string') {
    throw new Error('LandXML stream header has invalid unit names');
  }
  if (typeof raw.linear_scale_to_meters !== 'number' || !Number.isFinite(raw.linear_scale_to_meters)
    || typeof raw.elevation_scale_to_meters !== 'number' || !Number.isFinite(raw.elevation_scale_to_meters)) {
    throw new Error('LandXML stream header has invalid unit scales');
  }
  return {
    linearUnit: raw.linear_unit,
    elevationUnit: raw.elevation_unit,
    linearScaleToMeters: raw.linear_scale_to_meters,
    elevationScaleToMeters: raw.elevation_scale_to_meters,
    // #5175: read the provenance the header actually carries. Hardcoding
    // `false` here would silently strip it on the streaming path — the exact
    // path the viewer loads through — so a surface drawn at an operator-chosen
    // scale would claim the producer declared it.
    assumed: raw.assumed === true,
  };
}

function surfaceComponent(component: ReturnType<typeof buildLandXmlSurfaceComponents>['components'][number]): LandXmlStreamedComponent {
  return {
    mesh: component.mesh,
    surfaceName: component.surfaceName,
    surfaceSourceId: component.surfaceSourceId,
    pipeSourceId: component.pipeSourceId,
    renderedFaceSourceIds: component.renderedFaceSourceIds,
  };
}

function sourceSpatialReference(
  coordinateSystem: LandXmlTinDocument['coordinateSystem'],
): ModelSpatialReference | undefined {
  const metadata = spatialMetadataFromLandXml({ coordinateSystem });
  return metadata.horizontalId && metadata.verticalId
    ? spatialReferenceFromSourceMetadata(metadata)
    : undefined;
}

/**
 * Run the exact credited source cursor passes. Every sink call is awaited, so
 * local parsing and worker messages preserve the same cancellation and phase
 * fence: preflight → measure → freeze → admit → freezeAdmission → raw slots.
 */
export async function streamLandXmlBlobWithSink(
  api: LandXmlCursorApi,
  file: Blob,
  sink: LandXmlBlobStreamSink,
  options: LandXmlBlobStreamOptions,
): Promise<LandXmlBlobStreamResult> {
  const totalPasses = options.wantsFederatedStreaming ? 4 : 2;
  const reducer = new LandXmlStreamPreflightReducer();
  await streamLandXmlSourceBlobWithApi(api, file, {
    isCurrent: options.isCurrent,
    assumedLinearUnit: options.assumedLinearUnit,
    onProgress: (loadedBytes, totalBytes) => sink.onProgress?.(loadedBytes, totalBytes * totalPasses),
    onHeader: (header) => reducer.onHeader(header),
    onSurface: (surface) => reducer.onSurface(surface),
    onEvent: (event) => reducer.onEvent(event),
  });
  const reduced = reducer.finish();
  const preflight = reduced.preflight;
  const requestedFederatedStreaming = await sink.onPreflight(
    preflight,
    reduced.sourceCoordinateInfo,
    sourceSpatialReference(reduced.coordinateSystem),
  );
  const federatedStreaming = options.wantsFederatedStreaming && requestedFederatedStreaming;

  if (!federatedStreaming && options.wantsFederatedStreaming) {
    sink.onProgress?.(file.size, file.size * 2);
  }
  if (federatedStreaming) {
    let measured = 0;
    const measurement = new LandXmlStreamPreflightReducer(async (component) => {
      component.mesh.expressId = ++measured;
      await sink.onPreflightComponent?.(component);
    });
    await streamLandXmlSourceBlobWithApi(api, file, {
      isCurrent: options.isCurrent,
      assumedLinearUnit: options.assumedLinearUnit,
      onProgress: (loadedBytes, totalBytes) => sink.onProgress?.(totalBytes + loadedBytes, totalBytes * 4),
      onHeader: (header) => measurement.onHeader(header),
      onSurface: (surface) => measurement.onSurface(surface),
      onEvent: (event) => measurement.onEvent(event),
    });
    if (measurement.finish().preflight.componentCount !== preflight.componentCount || measured !== preflight.componentCount) {
      throw new Error('LandXML federation preflight did not reproduce its component envelope');
    }
    await sink.onPreflightComplete?.();

    let admitted = 0;
    const admission = new LandXmlStreamPreflightReducer(async (component) => {
      component.mesh.expressId = ++admitted;
      await sink.onFederatedAdmissionComponent?.(component);
    });
    await streamLandXmlSourceBlobWithApi(api, file, {
      isCurrent: options.isCurrent,
      assumedLinearUnit: options.assumedLinearUnit,
      onProgress: (loadedBytes, totalBytes) => sink.onProgress?.((totalBytes * 2) + loadedBytes, totalBytes * 4),
      onHeader: (header) => admission.onHeader(header),
      onSurface: (surface) => admission.onSurface(surface),
      onEvent: (event) => admission.onEvent(event),
    });
    if (admission.finish().preflight.componentCount !== preflight.componentCount || admitted !== preflight.componentCount) {
      throw new Error('LandXML federation admission did not reproduce its component envelope');
    }
    await sink.onFederatedAdmissionComplete?.();
  }

  let units: NonNullable<LandXmlTinDocument['units']> | null = null;
  let nextLocalId = 1;
  let retainedPrimaryComponents = 0;
  let droppedPrimaryComponents = 0;
  await streamLandXmlSourceBlobWithApi(api, file, {
    isCurrent: options.isCurrent,
    assumedLinearUnit: options.assumedLinearUnit,
    onProgress: (loadedBytes, totalBytes) => sink.onProgress?.(
      federatedStreaming ? (totalBytes * 3) + loadedBytes : totalBytes + loadedBytes,
      totalBytes * (federatedStreaming ? 4 : 2),
    ),
    onHeader: (header) => { units = streamUnits(header); },
    onSurface: async (surface) => {
      const decodedSurface = readLandXmlTinSurface(surface);
      if (decodedSurface.renderState !== 'rendered' || !decodedSurface.faceVisibility.some(Boolean)) return;
      if (units === null) throw new Error('LandXML surface arrived before stream Units');
      const built = buildLandXmlSurfaceComponents(decodedSurface, units, nextLocalId);
      await sink.onSurfaceDiagnostics({
        surfaceSourceId: decodedSurface.sourceId,
        surfaceName: decodedSurface.name,
        droppedDegenerateFaces: built.droppedDegenerateFaces,
        droppedPrecisionFaces: built.droppedPrecisionFaces,
        hasNoRenderableFaces: built.components.length === 0,
      });
      if (federatedStreaming) {
        for (const component of built.components) {
          component.mesh.expressId = nextLocalId++;
          await sink.onComponent(surfaceComponent(component));
        }
        return;
      }
      const placed = placeComponentsInKnownRenderFrame(
        built.components,
        preflight.frame ?? { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false },
        [],
      );
      const placedComponents = new Set(placed.placed);
      for (const component of built.components) {
        component.mesh.expressId = nextLocalId++;
        if (placedComponents.has(component)) {
          retainedPrimaryComponents++;
          await sink.onComponent(surfaceComponent(component));
        } else {
          droppedPrimaryComponents++;
          const streamed = surfaceComponent(component);
          await sink.onSkippedComponent({
            expressId: streamed.mesh.expressId,
            ...(streamed.surfaceSourceId === null ? {} : { surfaceSourceId: streamed.surfaceSourceId }),
            ...(streamed.renderedFaceSourceIds.length === 0 ? {} : { renderedFaceSourceIds: streamed.renderedFaceSourceIds }),
          });
        }
      }
    },
    onEvent: (event) => sink.onSourceEvent(event),
  });
  if (!federatedStreaming && preflight.componentCount > 0
    && nextLocalId - 1 === preflight.componentCount && retainedPrimaryComponents === 0) {
    throw new Error('LandXML primary preflight rejected every render component');
  }
  return { preflight, droppedPrimaryComponents, federatedStreaming };
}
