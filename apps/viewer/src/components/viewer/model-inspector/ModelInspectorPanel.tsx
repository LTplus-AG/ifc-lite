/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector side panel (charter #6232, M2 §1.7). The Model
 * workspace shows it on entry and puts the previous panel back on exit.
 *
 * It edits one of two targets (`useInspectorTarget`): the defaults the
 * running command builds with ("Defaults · Wall"), or the selected element
 * ("IfcWall #995 · L1"), with a pill when both apply. Sections: Name
 * (selection), Type, Dimensions, Material layers (walls and slab-likes) and
 * Hosting (doors and windows). Every edit is one undo step.
 */

import { useId, useMemo } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { EditElement } from '@/icons';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { AUTHORED_KINDS, entityName, layerSetOf, readLayerSet, typeOf } from '@/lib/commands/modeling/authored-kinds';
import { authoringDim, type AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import { CommitField, InspectorCaption, InspectorRow } from './InspectorControls';
import { DefaultDimensions, SelectionDimensions } from './DimensionsSection';
import { HostingSection } from './HostingSection';
import { DefaultProfile, SelectionProfile, isProfileOwner } from './ProfileInspectorSection';
import { KIND_LABEL } from './inspector-fields';
import { LayersSection } from './LayersSection';
import { TypeSection } from './TypeSection';
import { renameElement } from './inspector-edits';
import { useInspectorTarget, type InspectorSelection, type InspectorTarget } from './useInspectorTarget';

const HOSTED: ReadonlySet<AuthoredElementKind> = new Set(['door', 'window']);

export function ModelInspectorPanel({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const hasModel = useViewerStore((s) => s.models.size > 0);
  const canEdit = useViewerStore((s) => s.canCollabEdit());
  const enter = useViewerStore((s) => s.enterModelWorkspace);
  const target = useInspectorTarget();
  const { mode, selection, defaultsKind } = target;

  const title = mode === 'selection' && selection
    ? selection.storeyName
      ? t('modelInspector.header.selectionOnStorey', { ifcClass: selection.ifcClass, id: selection.expressId, storey: selection.storeyName })
      : t('modelInspector.header.selection', { ifcClass: selection.ifcClass, id: selection.expressId })
    : mode === 'defaults' && defaultsKind
      ? t('modelInspector.header.defaults', { kind: t(KIND_LABEL[defaultsKind]) })
      : t('modelInspector.panel.title');

  return (
    <div data-model-inspector data-inspector-mode={mode ?? undefined} className="flex h-full min-h-0 flex-col" aria-label={t('modelInspector.panel.title')}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <EditElement aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 data-inspector-title className="flex-1 truncate text-xs font-medium">{title}</h2>
        {onClose && (
          <IconButton label={t('modelInspector.close')} className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      {!hasModel || !target.inSession || !mode ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          {!hasModel ? (
            <p className="max-w-[16rem] text-xs text-muted-foreground">{t('modelInspector.empty.noModel')}</p>
          ) : !target.inSession ? (
            <>
              <p className="max-w-[16rem] text-xs text-muted-foreground">{t('modelInspector.empty.noSession')}</p>
              <Button size="sm" variant="outline" disabled={!canEdit} onClick={() => enter()}>
                <EditElement aria-hidden className="h-3.5 w-3.5" />
                {t('modelInspector.empty.enter')}
              </Button>
            </>
          ) : (
            <p data-model-inspector-idle className="max-w-[16rem] text-xs text-muted-foreground">{t('modelInspector.empty.idle')}</p>
          )}
        </div>
      ) : (
        <>
          <InspectorToolbar target={target} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {mode === 'selection' && selection ? <SelectionBody key={`${selection.modelId}:${selection.expressId}`} selection={selection} /> : null}
            {mode === 'defaults' && defaultsKind && target.sessionModel ? (
              <DefaultsBody kind={defaultsKind} modelId={target.sessionModel.modelId} live={target.sessionModel.live} />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function InspectorToolbar({ target }: { target: InspectorTarget }) {
  const { t } = useTranslation();
  const { idle } = target;
  const openProperties = () => useViewerStore.getState().showWorkspacePanel('properties');
  if (!target.both && !target.selection && !idle) return null;
  return (
    <div className="flex min-h-9 items-center gap-2 border-b border-border px-3 py-1.5">
      {target.both && target.mode && (
        <SegmentedControl
          size="sm"
          label={t('modelInspector.mode.aria')}
          value={target.mode}
          onValueChange={target.setMode}
          options={[
            { value: 'defaults', label: t('modelInspector.mode.defaults') },
            { value: 'selection', label: t('modelInspector.mode.selection') },
          ]}
        />
      )}
      {idle && <p data-model-inspector-idle className="flex-1 text-2xs text-muted-foreground">{t('modelInspector.empty.idle')}</p>}
      {target.selection && (
        <Button size="sm" variant="ghost" className="ml-auto h-6 gap-0.5 px-1.5 text-2xs text-muted-foreground" onClick={openProperties}>
          {t('modelInspector.properties')}
          <ChevronRight aria-hidden className="!size-3" />
        </Button>
      )}
    </div>
  );
}

function DefaultsBody({ kind, modelId, live }: { kind: AuthoredElementKind; modelId: string; live: InspectorSelection['live'] }) {
  const defaults = useViewerStore((s) => s.authoringDefaults);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const typePick = defaults.typeIds[kind];
  const layerPick = defaults.layerSetIds[kind];
  const layers = useMemo(() => {
    void mutationVersion;
    return layerPick?.modelId === modelId ? readLayerSet(live, layerPick.expressId) : null;
  }, [layerPick, modelId, live, mutationVersion]);
  return (
    <>
      <TypeSection modelId={modelId} live={live} kind={kind} />
      <DefaultDimensions kind={kind} />
      {isProfileOwner(kind) && <DefaultProfile owner={kind} />}
      {AUTHORED_KINDS[kind].layers && (
        <LayersSection
          key={`${kind}:${layers ? layerPick?.expressId : 'none'}`}
          modelId={modelId}
          live={live}
          kind={kind}
          initial={layers ?? []}
          typeId={typePick?.modelId === modelId ? typePick.expressId : null}
          defaultThickness={authoringDim(defaults, kind, 'Thickness')}
        />
      )}
    </>
  );
}

function SelectionBody({ selection }: { selection: InspectorSelection }) {
  const { t } = useTranslation();
  const id = useId();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const defaults = useViewerStore((s) => s.authoringDefaults);
  const { modelId, expressId, kind, live } = selection;
  const { name, typeId, layerSet, thickness } = useMemo(() => {
    void mutationVersion;
    const layered = kind !== null && AUTHORED_KINDS[kind].layers !== undefined;
    const wallThickness = kind === 'wall' ? useViewerStore.getState().readWallEndpoints(modelId, expressId)?.thickness : undefined;
    return {
      name: entityName(live, expressId),
      typeId: typeOf(live, expressId),
      layerSet: layered ? layerSetOf(live, expressId) : null,
      thickness: wallThickness ?? (kind === null ? 0 : authoringDim(defaults, kind, 'Thickness')),
    };
  }, [live, modelId, expressId, kind, defaults, mutationVersion]);

  const rename = (next: string) => renameElement(modelId, expressId, next, name);

  return (
    <>
      <div className="border-b border-border px-3 py-3">
        <InspectorRow label={t('modelInspector.name.label')} htmlFor={id}>
          <CommitField id={id} value={name} onCommit={rename} placeholder={t('modelInspector.name.placeholder')} />
        </InspectorRow>
      </div>
      {kind === null && <div className="px-3 py-3"><InspectorCaption>{t('modelInspector.noSections', { ifcClass: selection.ifcClass })}</InspectorCaption></div>}
      {kind !== null && <TypeSection modelId={modelId} live={live} kind={kind} elementId={expressId} />}
      {kind !== null && !HOSTED.has(kind) && <SelectionDimensions selection={selection} />}
      {isProfileOwner(kind) && <SelectionProfile selection={selection} owner={kind} />}
      {kind !== null && AUTHORED_KINDS[kind].layers && (
        <LayersSection
          // Re-seed the draft when the applied layers change, or (with none) the wall's thickness does.
          key={`${expressId}:${layerSet?.layerSetId ?? `none:${thickness}`}`}
          modelId={modelId}
          live={live}
          kind={kind}
          elementId={expressId}
          initial={layerSet?.layers ?? []}
          inheritedFromType={layerSet?.via === 'type'}
          typeId={typeId}
          defaultThickness={thickness}
        />
      )}
      {kind !== null && HOSTED.has(kind) && <HostingSection selection={selection} />}
    </>
  );
}
