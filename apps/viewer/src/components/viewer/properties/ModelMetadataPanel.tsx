/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model metadata panel - displays file info, schema version, entity counts,
 * coordinate system info, and project information.
 */

import { useMemo } from 'react';
import { FileBox, BookMarked } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PropertySetCard } from './PropertySetCard';
import { GeoreferencingPanel } from './GeoreferencingPanel';
import type { PropertySet } from './encodingUtils';
import type { FederatedModel } from '@/store/types';
import { extractGeoreferencingOnDemand, extractProjectUnits, ProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { getIfcLengthUnitScale } from '@/lib/geo/effective-georef';
import { computeModelStats } from './modelMetadataStats';
import { collectEffectivePhysicalEntityIds } from '@/lib/physical-objects';
import { useTranslation } from '@/i18n';
import { formatLocaleDate, formatLocaleNumber } from '@/i18n/intlFormat';
import { InspectorHeading, InspectorRow } from './inspector-ui';
import { EXPRESS_DESCRIPTION_ATTRIBUTE, EXPRESS_GLOBAL_ID_ATTRIBUTE, EXPRESS_NAME_ATTRIBUTE } from './express-labels';
import { LandXmlModelSourceNavigation } from './LandXmlModelSourceNavigation';
import { FederationAssumptionsNotice } from './FederationAssumptionsNotice';
import { TerrainImageryCard } from './TerrainImageryCard';
import { effectiveClassificationSystems } from './effective-classification-systems';
import { normalizeMutationModelId } from '@/sdk/adapters/mutation-view';
import { useStreamingThrottled } from '@/hooks/useStreamingThrottled';
import { isModelStreaming } from '@/lib/streaming-refresh';
import { GaussianCaptureMetadataPanel } from './GaussianCaptureMetadataPanel';

/** Model metadata. A Gaussian capture is a different component type, so
 * switching between it and an IFC model remounts rather than reorders hooks. */
export function ModelMetadataPanel({ model }: { model: FederatedModel }) {
  return model.gaussianSplat
    ? <GaussianCaptureMetadataPanel model={model} capture={model.gaussianSplat} />
    : <IfcModelMetadataPanel model={model} />;
}

/** IFC (and source-model) metadata: file info, schema version, entity counts, etc. */
function IfcModelMetadataPanel({ model }: { model: FederatedModel }) {
  const { t, locale, revision } = useTranslation();
  const dataStore = model.ifcDataStore;
  const selectedLandXmlSource = useViewerStore((state) => state.selectedLandXmlSource);
  const setSelectedLandXmlSource = useViewerStore((state) => state.setSelectedLandXmlSource);
  // Display-unit converter overrides (issue #1573 proposal 2).
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const fromGlobalId = useViewerStore((s) => s.fromGlobalId);
  const mutationView = useViewerStore((s) => s.getMutationView?.(normalizeMutationModelId(s, model.id)));
  const mutationVersion = useViewerStore((s) => s.mutationVersion);

  // Format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${formatLocaleNumber(locale, bytes)} B`;
    if (bytes < 1024 * 1024) return `${formatLocaleNumber(locale, bytes / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
    return `${formatLocaleNumber(locale, bytes / (1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB`;
  };

  // Format date
  const formatDate = (timestamp: number): string => {
    return formatLocaleDate(locale, new Date(timestamp), { dateStyle: 'short', timeStyle: 'medium' });
  };

  // Get IfcProject data if available
  const projectData = useMemo(() => {
    if (!dataStore?.spatialHierarchy?.project) return null;
    const project = dataStore.spatialHierarchy.project;
    const projectId = project.expressId;

    // Get project entity attributes
    const name = dataStore.entities.getName(projectId);
    const globalId = dataStore.entities.getGlobalId(projectId);
    const description = dataStore.entities.getDescription(projectId);

    // Get project properties
    const properties: PropertySet[] = [];
    if (dataStore.properties) {
      for (const pset of dataStore.properties.getForEntity(projectId)) {
        properties.push({
          name: pset.name,
          properties: pset.properties.map(p => ({ name: p.name, value: p.value })),
        });
      }
    }

    return { name, globalId, description, properties };
  }, [dataStore]);

  // Membership changes with source/overlay edits, not with each streamed
  // geometry batch. Keep it stable while the shaped count catches up.
  const physicalIds = useMemo(
    () => dataStore?.spatialHierarchy ? collectEffectivePhysicalEntityIds(dataStore, mutationView) : new Set<number>(),
    [dataStore, mutationView, mutationVersion],
  );

  // Count storeys and elements — see `modelMetadataStats.ts` for what
  // "Elements with Geometry" means and why raw `byStorey` membership isn't it.
  // The count walks every mesh, so while this model's geometry streams it
  // follows the held geometry rather than every publish (#6411). Only this
  // model's own streaming geometry is held: another model, or this one
  // finishing, passes at once.
  const statsGeometry = useStreamingThrottled(
    { modelId: model.id, geometry: model.geometryResult, streaming: isModelStreaming(model) },
    (held, next) => held.modelId === next.modelId && held.streaming && next.streaming,
  ).geometry;
  const stats = useMemo(
    () => computeModelStats(dataStore, statsGeometry, {
      mutationView,
      physicalIds,
      // A completed cache hit may validly contain no geometry result. That is
      // a known-empty model, unlike the same null while streaming.
      geometryReady:
        statsGeometry != null ||
        model.loadState === 'complete' ||
        model.geometryLoadState === 'complete',
      toLocalId: (globalId) => {
        if (model.id === 'legacy' || model.id === 'default' || model.id === '__legacy__') {
          return globalId;
        }
        const ref = fromGlobalId(globalId);
        return ref?.modelId === model.id ? ref.expressId : undefined;
      },
    }),
    [dataStore, fromGlobalId, model.geometryLoadState, statsGeometry, model.id, model.loadState, mutationView, physicalIds],
  );

  // Extract georeferencing info
  const georef = useMemo(() => {
    if (!dataStore) return null;
    const info = extractGeoreferencingOnDemand(dataStore as IfcDataStore);
    return info?.hasGeoreference ? info : null;
  }, [dataStore, dataStore?.georeferencing]);

  // Extract length unit scale
  const unitInfo = useMemo(() => {
    if (!dataStore) return null;
    if (dataStore.lengthUnitScale === undefined && (!dataStore.source?.length || !dataStore.entityIndex)) return null;
    const scale = getIfcLengthUnitScale(dataStore);
    let unitName = t('properties.modelMetadata.unit.meters');
    if (Math.abs(scale - 0.001) < 0.0001) unitName = t('properties.modelMetadata.unit.millimeters');
    else if (Math.abs(scale - 0.01) < 0.001) unitName = t('properties.modelMetadata.unit.centimeters');
    else if (Math.abs(scale - 0.0254) < 0.001) unitName = t('properties.modelMetadata.unit.inches');
    else if (Math.abs(scale - 0.3048) < 0.01) unitName = t('properties.modelMetadata.unit.feet');
    return { scale, unitName };
  }, [dataStore, dataStore?.lengthUnitScale, t, revision]);

  // The file's declared units, for rendering unit suffixes on project
  // property values (issue #1573).
  const projectUnits = useMemo(() => {
    if (!dataStore?.source?.length || !dataStore?.entityIndex) return ProjectUnits.empty();
    return extractProjectUnits(dataStore.source, dataStore.entityIndex);
  }, [dataStore]);

  // Classification systems in this model's current edit session. `unresolved`
  // preserves the server-parsed no-source signal for names we cannot read.
  const classificationSystems = useMemo(() => {
    if (!dataStore) return { names: [], unresolved: false };
    return effectiveClassificationSystems(dataStore as IfcDataStore, mutationView);
  }, [dataStore, mutationView, mutationVersion]);
  const landXmlStats = useMemo(() => {
    const surfaces = model.landXmlDocument?.surfaces ?? [];
    return {
      surfaces: surfaces.length,
      points: surfaces.reduce((total, surface) => total + surface.points.length + surface.sourceDataPoints.length, 0),
      overlays: surfaces.reduce(
        (total, surface) => total + surface.boundaries.length + surface.breaklines.length + surface.contours.length,
        0,
      ),
    };
  }, [model.landXmlDocument]);

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header: the model's name in real case, its kind and schema quietly below */}
      <div className="border-b border-border px-3 py-2.5">
        <h3 className="line-clamp-2 break-words text-row font-semibold text-foreground" title={model.name}>
          {model.name}
        </h3>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <FileBox className="h-3 w-3 shrink-0" />
          <span className="truncate">{model.sourceSchema ? t('properties.modelMetadata.sourceModel') : t('properties.modelMetadata.ifcModel')}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 font-mono">{model.sourceSchema ?? model.schemaVersion}</span>
        </div>
      </div>

      {/* `min-h-0` is required: without it `flex-1` falls back to
          min-height:auto and the ScrollArea grows past the panel's
          height instead of constraining the inner viewport, so the map
          (and any tall content underneath) overflowed past the right
          panel's clip box. */}
      <ScrollArea className="flex-1 min-h-0">
        <FederationAssumptionsNotice model={model} />
        {/* File Information. The length unit is an ordinary row: amber is
            reserved for real warnings (#8802). */}
        <section className="border-b border-border pb-1">
          <InspectorHeading>{t('properties.modelMetadata.fileInformationHeading')}</InspectorHeading>
          <InspectorRow label={t('properties.modelMetadata.fileSize')} value={formatFileSize(model.fileSize)} copy={false} />
          <InspectorRow label={t('properties.modelMetadata.loadedAt')} value={formatDate(model.loadedAt)} mono copy={false} />
          {dataStore && dataStore.parseTime != null && (
            <InspectorRow label={t('properties.modelMetadata.parseTime')} value={t('properties.modelMetadata.parseTimeValue', { ms: formatLocaleNumber(locale, dataStore.parseTime, { maximumFractionDigits: 0 }) })} copy={false} />
          )}
          {unitInfo && (
            <InspectorRow
              label={t('properties.modelMetadata.lengthUnitHeading')}
              value={t('properties.modelMetadata.lengthUnitValue', { unitName: unitInfo.unitName, scale: formatLocaleNumber(locale, unitInfo.scale, { maximumFractionDigits: 6 }) })}
              mono={false}
              copy={false}
            />
          )}
        </section>

        {/* IfcProject Data — placed near the top so the model's name,
            description, and project-level psets are the first thing users
            see after file info. Previously the section was at the bottom
            of the panel (below the map), which buried critical project
            identity below scrollable georeferencing content. */}
        {projectData && (
          <section className="border-b border-border">
            <InspectorHeading>{t('properties.modelMetadata.projectInformationHeading')}</InspectorHeading>
            <div className="pb-1">
              {projectData.name && <InspectorRow label={EXPRESS_NAME_ATTRIBUTE} value={projectData.name} />}
              {projectData.description && <InspectorRow label={EXPRESS_DESCRIPTION_ATTRIBUTE} value={projectData.description} />}
              {projectData.globalId && <InspectorRow label={EXPRESS_GLOBAL_ID_ATTRIBUTE} value={projectData.globalId} mono />}
            </div>

            {/* Project Properties */}
            {projectData.properties.length > 0 && (
              <div className="border-t border-border">
                {projectData.properties.map((pset, index) => (
                  // Pset names are not unique per entity (two IfcPropertySet
                  // entities may legitimately share a Name); index disambiguates.
                  <PropertySetCard key={`${pset.name}-${index}`} pset={pset} projectUnits={projectUnits} unitDisplayOverrides={unitDisplayOverrides} />
                ))}
              </div>
            )}
          </section>
        )}

        {/* IFC entity statistics or truthful source-record counts. */}
        <section className="border-b border-border pb-1">
          <InspectorHeading>{model.sourceSchema ? t('properties.modelMetadata.sourceStatisticsHeading') : t('properties.modelMetadata.statisticsHeading')}</InspectorHeading>
          <InspectorRow
            label={model.sourceSchema ? t('properties.modelMetadata.sourceSurfaces') : t('properties.modelMetadata.totalEntities')}
            value={model.sourceSchema ? formatLocaleNumber(locale, landXmlStats.surfaces) : dataStore?.entityCount != null ? formatLocaleNumber(locale, dataStore.entityCount) : t('properties.modelMetadata.notAvailable')}
            copy={false}
          />
          <InspectorRow
            label={model.sourceSchema ? t('properties.modelMetadata.sourcePoints') : t('properties.modelMetadata.buildingStoreys')}
            value={formatLocaleNumber(locale, model.sourceSchema ? landXmlStats.points : stats.storeys)}
            copy={false}
          />
          <InspectorRow
            label={model.sourceSchema ? t('properties.modelMetadata.sourceOverlays') : t('properties.modelMetadata.elementsWithGeometry')}
            value={formatLocaleNumber(locale, model.sourceSchema ? landXmlStats.overlays : stats.elementsWithGeometry)}
            copy={false}
          />
          {!model.sourceSchema && (
            <InspectorRow label={t('properties.modelMetadata.maxExpressId')} value={formatLocaleNumber(locale, model.maxExpressId)} copy={false} />
          )}
        </section>

        {model.sourceSchema && model.landXmlDocument && <TerrainImageryCard model={model} />}

        {model.sourceSchema && model.landXmlDocument && <LandXmlModelSourceNavigation
          modelId={model.id}
          document={model.landXmlDocument}
          selected={selectedLandXmlSource}
          onSelect={setSelectedLandXmlSource}
        />}

        {/* Classification Systems — lists every system found in this
            model (not just one), matching the request that a model can
            carry several (Uniclass, OmniClass, a national system, ...). */}
        <section className="border-b border-border pb-1">
          <InspectorHeading>{t('properties.modelMetadata.classificationSystemsHeading')}</InspectorHeading>
          {classificationSystems.unresolved && (
            <p className="flex min-h-7 items-center gap-2 px-3 text-xs text-muted-foreground">
              <BookMarked className="h-3.5 w-3.5 shrink-0" />
              {t('properties.modelMetadata.classificationUnresolved')}
            </p>
          )}
          {!classificationSystems.unresolved && classificationSystems.names.length === 0 && (
            <p className="flex min-h-7 items-center gap-2 px-3 text-xs text-muted-foreground">
              <BookMarked className="h-3.5 w-3.5 shrink-0" />
              {t('properties.modelMetadata.noClassificationSystems')}
            </p>
          )}
          {classificationSystems.names.map((system) => (
            <p key={system} className="flex min-h-7 items-center gap-2 px-3 text-xs text-foreground">
              <BookMarked className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{system}</span>
            </p>
          ))}
        </section>

        {/* Georeferencing — kept at the bottom because it embeds a
            tall location map; placing it earlier would push the
            statistics + project metadata below the fold. */}
        <GeoreferencingPanel georef={georef} modelId={model.id} enableEditing schemaVersion={model.schemaVersion} coordinateInfo={model.geometryResult?.coordinateInfo} geometryResult={model.geometryResult} lengthUnitScale={unitInfo?.scale} />
      </ScrollArea>
    </div>
  );
}
