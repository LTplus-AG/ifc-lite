/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector's Type section (charter #6232, M2 §1.7.1): the
 * `IfcXxxType`s of the element's class in the model (file and session),
 * "No type", and "New type…".
 *
 * Selection mode types the element right away (IfcRelDefinesByType, one
 * undo step). Defaults mode stores the pick for the kind; the transaction
 * types every element a command builds with it (`authored-defaults.ts`).
 */

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { AUTHORED_KINDS, typeOf, typesOfKind, type LiveModel } from '@/lib/commands/modeling/authored-kinds';
import { detachFromType, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import type { AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import { InspectorCaption, InspectorRow, InspectorSection } from './InspectorControls';
import { runInspectorEdit } from './useInspectorTarget';

const NONE = 'none';
const NEW = 'new';

export interface TypeSectionProps {
  modelId: string;
  live: LiveModel;
  kind: AuthoredElementKind;
  /** The element to type; absent in defaults mode. */
  elementId?: number;
}

export function TypeSection({ modelId, live, kind, elementId }: TypeSectionProps) {
  const { t } = useTranslation();
  const id = useId();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const defaultPick = useViewerStore((s) => s.authoringDefaults.typeIds[kind]);
  const [naming, setNaming] = useState(false);

  const types = useMemo(() => { void mutationVersion; return typesOfKind(live, kind); }, [live, kind, mutationVersion]);
  const current = useMemo(() => {
    void mutationVersion;
    if (elementId !== undefined) return typeOf(live, elementId);
    return defaultPick?.modelId === modelId && types.some((type) => type.expressId === defaultPick.expressId) ? defaultPick.expressId : null;
  }, [live, elementId, defaultPick, modelId, types, mutationVersion]);

  const pickDefault = (typeId: number | null) => {
    const { typeIds } = useViewerStore.getState().authoringDefaults;
    const { [kind]: _dropped, ...rest } = typeIds;
    useViewerStore.getState().setAuthoringDefaults({ typeIds: typeId === null ? rest : { ...rest, [kind]: { modelId, expressId: typeId } } });
  };

  const choose = (value: string) => {
    if (value === NEW) { setNaming(true); return; }
    const typeId = value === NONE ? null : Number(value);
    if (elementId === undefined) { pickDefault(typeId); return; }
    runInspectorEdit(modelId, (tx) => {
      recordModellingEdit(useViewerStore, tx.modelId, (methods, draft) => {
        if (typeId === null) detachFromType(draft, live.dataStore, [elementId]);
        else methods.assignType(tx.modelId, typeId, [elementId]);
      });
      return [];
    });
  };

  const create = (Name: string) => {
    let typeId: number | null = null;
    const ok = runInspectorEdit(modelId, (tx) => {
      recordModellingEdit(useViewerStore, tx.modelId, (methods) => {
        typeId = methods.addElementType(tx.modelId, { Type: AUTHORED_KINDS[kind].type, Name }).expressId;
        if (elementId !== undefined) methods.assignType(tx.modelId, typeId, [elementId]);
      });
      return [];
    });
    if (ok && elementId === undefined && typeId !== null) pickDefault(typeId);
    if (ok) setNaming(false);
  };

  return (
    <InspectorSection title={t('modelInspector.type.title')}>
      <InspectorRow label={t('modelInspector.type.label')} htmlFor={id}>
        <Select value={current === null ? NONE : String(current)} onValueChange={choose}>
          <SelectTrigger id={id} data-inspector-type className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE} className="text-xs">{t('modelInspector.type.none')}</SelectItem>
            {types.map((type) => (
              <SelectItem key={type.expressId} value={String(type.expressId)} className="text-xs">{type.name}</SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={NEW} className="text-xs">{t('modelInspector.type.new')}</SelectItem>
          </SelectContent>
        </Select>
      </InspectorRow>
      {naming && <NewTypeRow placeholder={AUTHORED_KINDS[kind].type} onCreate={create} onCancel={() => setNaming(false)} />}
      {elementId === undefined && current !== null && <InspectorCaption>{t('modelInspector.type.defaultsHint')}</InspectorCaption>}
    </InspectorSection>
  );
}

/** "New type…": a name, then Create (or Enter). Escape or Cancel closes it without writing. */
function NewTypeRow({ placeholder, onCreate, onCancel }: { placeholder: string; onCreate: (name: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) onCreate(name.trim());
  };
  return (
    <form onSubmit={submit}>
      <InspectorRow label={t('modelInspector.type.newName')} htmlFor={id}>
        <div className="flex items-center gap-1">
          <Input
            id={id}
            ref={input}
            value={name}
            placeholder={placeholder}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') onCancel(); }}
            className="h-7 flex-1 text-xs"
          />
          <Button type="submit" size="sm" variant="outline" disabled={!name.trim()} className="h-7 px-2 text-2xs">
            {t('modelInspector.type.create')}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-2xs" onClick={onCancel}>
            {t('modelInspector.type.cancel')}
          </Button>
        </div>
      </InspectorRow>
    </form>
  );
}
