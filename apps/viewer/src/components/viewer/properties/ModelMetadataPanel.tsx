/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model metadata panel - displays file info, schema version, entity counts,
 * coordinate system info, and project information.
 */

import { useMemo } from 'react';
import {
  Layers,
  FileText,
  Tag,
  FileBox,
  Clock,
  HardDrive,
  Hash,
  Database,
  Building2,
  Ruler,
  BookMarked,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PropertySetCard } from './PropertySetCard';
import { GeoreferencingPanel } from './GeoreferencingPanel';
import type { PropertySet } from './encodingUtils';
import type { FederatedModel } from '@/store/types';
import { extractGeoreferencingOnDemand, extractLengthUnitScale, extractProjectUnits, ProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { computeModelStats } from './modelMetadataStats';
import { collectEffectivePhysicalEntityIds } from '@/lib/physical-objects';
import { useTranslation } from '@/i18n';
import { formatLocaleDate, formatLocaleNumber } from '@/i18n/intlFormat';
import { EXPRESS_DESCRIPTION_ATTRIBUTE, EXPRESS_GLOBAL_ID_ATTRIBUTE, EXPRESS_NAME_ATTRIBUTE } from './express-labels';
import { LandXmlModelSourceNavigation } from './LandXmlModelSourceNavigation';
import { effectiveClassificationSystems } from './effective-classification-systems';
import { normalizeMutationModelId } from '@/sdk/adapters/mutation-view';

/** Model metadata panel - displays file info, schema version, entity counts, etc. */
export function ModelMetadataPanel({ model }: { model: FederatedModel }) {
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
  const stats = useMemo(
    () => computeModelStats(dataStore, model.geometryResult, {
      mutationView,
      physicalIds,
      // A completed cache hit may validly contain no geometry result. That is
      // a known-empty model, unlike the same null while streaming.
      geometryReady:
        model.geometryResult != null ||
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
    [dataStore, fromGlobalId, model.geometryLoadState, model.geometryResult, model.id, model.loadState, mutationView, physicalIds],
  );

  // Extract georeferencing info
  const georef = useMemo(() => {
    if (!dataStore) return null;
    const info = extractGeoreferencingOnDemand(dataStore as IfcDataStore);
    return info?.hasGeoreference ? info : null;
  }, [dataStore]);

  // Extract length unit scale
  const unitInfo = useMemo(() => {
    if (!dataStore?.source?.length || !dataStore?.entityIndex) return null;
    const scale = extractLengthUnitScale(dataStore.source, dataStore.entityIndex);
    let unitName = t('properties.modelMetadata.unit.meters');
    if (Math.abs(scale - 0.001) < 0.0001) unitName = t('properties.modelMetadata.unit.millimeters');
    else if (Math.abs(scale - 0.01) < 0.001) unitName = t('properties.modelMetadata.unit.centimeters');
    else if (Math.abs(scale - 0.0254) < 0.001) unitName = t('properties.modelMetadata.unit.inches');
    else if (Math.abs(scale - 0.3048) < 0.01) unitName = t('properties.modelMetadata.unit.feet');
    return { scale, unitName };
  }, [dataStore, t, revision]);

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
    <div className="h-full flex flex-col border-l-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
      {/* Header */}
      <div className="p-4 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black space-y-3">
        <div className="flex items-start gap-3">
          <div className="p-2 border-2 border-primary/30 bg-primary/10 shrink-0 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.1)]">
            <FileBox className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <h3 className="font-bold text-sm truncate uppercase tracking-tight text-zinc-900 dark:text-zinc-100">
              {model.name}
            </h3>
            <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400">{model.sourceSchema ? t('properties.modelMetadata.sourceModel') : t('properties.modelMetadata.ifcModel')}</p>
          </div>
        </div>

        {/* Schema badge */}
        <div className="flex items-center gap-2">
          <span className="text-2xs font-mono bg-primary/10 border border-primary/30 px-2 py-1 text-primary font-bold uppercase">
            {model.sourceSchema ?? model.schemaVersion}
          </span>
        </div>
      </div>

      {/* `min-h-0` is required: without it `flex-1` falls back to
          min-height:auto and the ScrollArea grows past the panel's
          height instead of constraining the inner viewport, so the map
          (and any tall content underneath) overflowed past the right
          panel's clip box. */}
      <ScrollArea className="flex-1 min-h-0">
        {/* File Information */}
        <div className="border-b border-zinc-200 dark:border-zinc-800">
          <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50">
            <h4 className="font-bold text-xs uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
              {t('properties.modelMetadata.fileInformationHeading')}
            </h4>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
            <div className="flex items-center gap-3 px-3 py-2">
              <HardDrive className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500">{t('properties.modelMetadata.fileSize')}</span>
              <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                {formatFileSize(model.fileSize)}
              </span>
            </div>
            <div className="flex items-center gap-3 px-3 py-2">
              <Clock className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500">{t('properties.modelMetadata.loadedAt')}</span>
              <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                {formatDate(model.loadedAt)}
              </span>
            </div>
            {dataStore && dataStore.parseTime != null && (
              <div className="flex items-center gap-3 px-3 py-2">
                <Clock className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                <span className="text-xs text-zinc-500">{t('properties.modelMetadata.parseTime')}</span>
                <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                  {t('properties.modelMetadata.parseTimeValue', { ms: formatLocaleNumber(locale, dataStore.parseTime, { maximumFractionDigits: 0 }) })}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Length Unit */}
        {unitInfo && (
          <div className="border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-3 px-3 py-2.5 bg-amber-50/50 dark:bg-amber-950/20">
              <Ruler className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">{t('properties.modelMetadata.lengthUnitHeading')}</span>
              <span className="text-xs font-mono text-amber-800 dark:text-amber-300 ml-auto">
                {t('properties.modelMetadata.lengthUnitValue', { unitName: unitInfo.unitName, scale: formatLocaleNumber(locale, unitInfo.scale, { maximumFractionDigits: 6 }) })}
              </span>
            </div>
          </div>
        )}

        {/* IfcProject Data — placed near the top so the model's name,
            description, and project-level psets are the first thing users
            see after file info. Previously the section was at the bottom
            of the panel (below the map), which buried critical project
            identity below scrollable georeferencing content. */}
        {projectData && (
          <div className="border-b border-zinc-200 dark:border-zinc-800">
            <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50">
              <h4 className="font-bold text-xs uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
                {t('properties.modelMetadata.projectInformationHeading')}
              </h4>
            </div>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {projectData.name && (
                <div className="flex items-center gap-3 px-3 py-2">
                  <Tag className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                  <span className="text-xs text-zinc-500">{EXPRESS_NAME_ATTRIBUTE}</span>
                  <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 ml-auto truncate max-w-[60%]">
                    {projectData.name}
                  </span>
                </div>
              )}
              {projectData.description && (
                <div className="flex items-start gap-3 px-3 py-2">
                  <FileText className="h-3.5 w-3.5 text-zinc-400 shrink-0 mt-0.5" />
                  <span className="text-xs text-zinc-500 shrink-0">{EXPRESS_DESCRIPTION_ATTRIBUTE}</span>
                  <span className="text-xs text-zinc-900 dark:text-zinc-100 ml-auto text-right max-w-[60%]">
                    {projectData.description}
                  </span>
                </div>
              )}
              {projectData.globalId && (
                <div className="flex items-center gap-3 px-3 py-2">
                  <Hash className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                  <span className="text-xs text-zinc-500">{EXPRESS_GLOBAL_ID_ATTRIBUTE}</span>
                  <code className="text-2xs font-mono text-zinc-600 dark:text-zinc-400 ml-auto truncate max-w-[60%]">
                    {projectData.globalId}
                  </code>
                </div>
              )}
            </div>

            {/* Project Properties */}
            {projectData.properties.length > 0 && (
              <div className="p-3 pt-0 space-y-2">
                {projectData.properties.map((pset, index) => (
                  // Pset names are not unique per entity (two IfcPropertySet
                  // entities may legitimately share a Name); index disambiguates.
                  <PropertySetCard key={`${pset.name}-${index}`} pset={pset} projectUnits={projectUnits} unitDisplayOverrides={unitDisplayOverrides} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* IFC entity statistics or truthful source-record counts. */}
        <div className="border-b border-zinc-200 dark:border-zinc-800">
          <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50">
            <h4 className="font-bold text-xs uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
              {model.sourceSchema ? t('properties.modelMetadata.sourceStatisticsHeading') : t('properties.modelMetadata.statisticsHeading')}
            </h4>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
            <div className="flex items-center gap-3 px-3 py-2">
              <Database className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500">{model.sourceSchema ? t('properties.modelMetadata.sourceSurfaces') : t('properties.modelMetadata.totalEntities')}</span>
              <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                {model.sourceSchema ? formatLocaleNumber(locale, landXmlStats.surfaces) : dataStore?.entityCount != null ? formatLocaleNumber(locale, dataStore.entityCount) : t('properties.modelMetadata.notAvailable')}
              </span>
            </div>
            <div className="flex items-center gap-3 px-3 py-2">
              <Layers className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500">{model.sourceSchema ? t('properties.modelMetadata.sourcePoints') : t('properties.modelMetadata.buildingStoreys')}</span>
              <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                {formatLocaleNumber(locale, model.sourceSchema ? landXmlStats.points : stats.storeys)}
              </span>
            </div>
            <div className="flex items-center gap-3 px-3 py-2">
              <Building2 className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500">{model.sourceSchema ? t('properties.modelMetadata.sourceOverlays') : t('properties.modelMetadata.elementsWithGeometry')}</span>
              <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                {formatLocaleNumber(locale, model.sourceSchema ? landXmlStats.overlays : stats.elementsWithGeometry)}
              </span>
            </div>
            {!model.sourceSchema && (
              <div className="flex items-center gap-3 px-3 py-2">
                <Hash className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                <span className="text-xs text-zinc-500">{t('properties.modelMetadata.maxExpressId')}</span>
                <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                  {formatLocaleNumber(locale, model.maxExpressId)}
                </span>
              </div>
            )}
          </div>
        </div>

        {model.sourceSchema && model.landXmlDocument && <LandXmlModelSourceNavigation
          modelId={model.id}
          document={model.landXmlDocument}
          selected={selectedLandXmlSource}
          onSelect={setSelectedLandXmlSource}
        />}

        {/* Classification Systems — lists every system found in this
            model (not just one), matching the request that a model can
            carry several (Uniclass, OmniClass, a national system, ...). */}
        <div className="border-b border-zinc-200 dark:border-zinc-800">
          <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50">
            <h4 className="font-bold text-xs uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
              {t('properties.modelMetadata.classificationSystemsHeading')}
            </h4>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {classificationSystems.unresolved && (
              <div className="flex items-center gap-3 px-3 py-2">
                <BookMarked className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                <span className="text-xs text-zinc-500">{t('properties.modelMetadata.classificationUnresolved')}</span>
              </div>
            )}
            {!classificationSystems.unresolved && classificationSystems.names.length === 0 && (
              <div className="flex items-center gap-3 px-3 py-2">
                <BookMarked className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                <span className="text-xs text-zinc-500">{t('properties.modelMetadata.noClassificationSystems')}</span>
              </div>
            )}
            {classificationSystems.names.map((system) => (
              <div key={system} className="flex items-center gap-3 px-3 py-2">
                <BookMarked className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100">
                  {system}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Georeferencing — kept at the bottom because it embeds a
            tall location map; placing it earlier would push the
            statistics + project metadata below the fold. */}
        <GeoreferencingPanel georef={georef} modelId={model.id} enableEditing schemaVersion={model.schemaVersion} coordinateInfo={model.geometryResult?.coordinateInfo} geometryResult={model.geometryResult} lengthUnitScale={unitInfo?.scale} />
      </ScrollArea>
    </div>
  );
}
