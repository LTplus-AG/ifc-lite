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
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PropertySetCard } from './PropertySetCard';
import { GeoreferencingPanel } from './GeoreferencingPanel';
import type { PropertySet } from './encodingUtils';
import type { FederatedModel } from '@/store/types';
import { extractGeoreferencingOnDemand, extractLengthUnitScale, type IfcDataStore } from '@ifc-lite/parser';

/** Model metadata panel - displays file info, schema version, entity counts, etc. */
export function ModelMetadataPanel({ model }: { model: FederatedModel }) {
  const dataStore = model.ifcDataStore;

  // Format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  // Format date
  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
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

  // Count storeys and elements
  const stats = useMemo(() => {
    if (!dataStore?.spatialHierarchy) {
      return { storeys: 0, elementsWithGeometry: 0 };
    }
    const storeys = dataStore.spatialHierarchy.byStorey.size;
    let elementsWithGeometry = 0;
    for (const elements of dataStore.spatialHierarchy.byStorey.values()) {
      elementsWithGeometry += (elements as number[]).length;
    }
    return { storeys, elementsWithGeometry };
  }, [dataStore]);

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
    let unitName = 'Meters';
    if (Math.abs(scale - 0.001) < 0.0001) unitName = 'Millimeters';
    else if (Math.abs(scale - 0.01) < 0.001) unitName = 'Centimeters';
    else if (Math.abs(scale - 0.0254) < 0.001) unitName = 'Inches';
    else if (Math.abs(scale - 0.3048) < 0.01) unitName = 'Feet';
    return { scale, unitName };
  }, [dataStore]);

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
            <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400">IFC Model</p>
          </div>
        </div>

        {/* Schema badge */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono bg-primary/10 border border-primary/30 px-2 py-1 text-primary font-bold uppercase">
            {model.schemaVersion}
          </span>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {/* File Information */}
        <div className="border-b border-zinc-200 dark:border-zinc-800">
          <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50">
            <h4 className="font-bold text-xs uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
              File Information
            </h4>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
            <div className="flex items-center gap-3 px-3 py-2">
              <HardDrive className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500">File Size</span>
              <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                {formatFileSize(model.fileSize)}
              </span>
            </div>
            <div className="flex items-center gap-3 px-3 py-2">
              <Clock className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500">Loaded At</span>
              <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                {formatDate(model.loadedAt)}
              </span>
            </div>
            {dataStore && dataStore.parseTime != null && (
              <div className="flex items-center gap-3 px-3 py-2">
                <Clock className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                <span className="text-xs text-zinc-500">Parse Time</span>
                <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                  {dataStore.parseTime.toFixed(0)} ms
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
              <span className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Length Unit</span>
              <span className="text-xs font-mono text-amber-800 dark:text-amber-300 ml-auto">
                {unitInfo.unitName} ({unitInfo.scale})
              </span>
            </div>
          </div>
        )}

        {/* Entity Statistics */}
        <div className="border-b border-zinc-200 dark:border-zinc-800">
          <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50">
            <h4 className="font-bold text-xs uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
              Statistics
            </h4>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
            <div className="flex items-center gap-3 px-3 py-2">
              <Database className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500">Total Entities</span>
              <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                {dataStore?.entityCount?.toLocaleString() ?? 'N/A'}
              </span>
            </div>
            <div className="flex items-center gap-3 px-3 py-2">
              <Layers className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500">Building Storeys</span>
              <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                {stats.storeys}
              </span>
            </div>
            <div className="flex items-center gap-3 px-3 py-2">
              <Building2 className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500">Elements with Geometry</span>
              <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                {stats.elementsWithGeometry.toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-3 px-3 py-2">
              <Hash className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500">Max Express ID</span>
              <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto">
                {model.maxExpressId.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        {/* Georeferencing */}
        <GeoreferencingPanel georef={georef} modelId={model.id} enableEditing schemaVersion={model.schemaVersion} coordinateInfo={model.geometryResult?.coordinateInfo} geometryResult={model.geometryResult} lengthUnitScale={unitInfo?.scale} />

        {/* IfcProject Data */}
        {projectData && (
          <div className="border-b border-zinc-200 dark:border-zinc-800">
            <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50">
              <h4 className="font-bold text-xs uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
                Project Information
              </h4>
            </div>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {projectData.name && (
                <div className="flex items-center gap-3 px-3 py-2">
                  <Tag className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                  <span className="text-xs text-zinc-500">Name</span>
                  <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 ml-auto truncate max-w-[60%]">
                    {projectData.name}
                  </span>
                </div>
              )}
              {projectData.description && (
                <div className="flex items-start gap-3 px-3 py-2">
                  <FileText className="h-3.5 w-3.5 text-zinc-400 shrink-0 mt-0.5" />
                  <span className="text-xs text-zinc-500 shrink-0">Description</span>
                  <span className="text-xs text-zinc-900 dark:text-zinc-100 ml-auto text-right max-w-[60%]">
                    {projectData.description}
                  </span>
                </div>
              )}
              {projectData.globalId && (
                <div className="flex items-center gap-3 px-3 py-2">
                  <Hash className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                  <span className="text-xs text-zinc-500">GlobalId</span>
                  <code className="text-[10px] font-mono text-zinc-600 dark:text-zinc-400 ml-auto truncate max-w-[60%]">
                    {projectData.globalId}
                  </code>
                </div>
              )}
            </div>

            {/* Project Properties */}
            {projectData.properties.length > 0 && (
              <div className="p-3 pt-0 space-y-2">
                {projectData.properties.map((pset) => (
                  <PropertySetCard key={pset.name} pset={pset} />
                ))}
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
