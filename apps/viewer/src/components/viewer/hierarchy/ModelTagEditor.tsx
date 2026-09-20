/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Assign / create / rename / delete model tags (#4215), for one model or for
 * every model in the federation at once (bulk add / remove).
 *
 * The "add" field autocompletes from the federation's existing tags and
 * creates a new tag on Enter when nothing matches — the slice's
 * `createModelTag` returns the existing id for a name that already exists
 * (case-insensitive), so typing "structure" next to an existing "Structure"
 * assigns rather than duplicates.
 *
 * A dialog, not a popover: the editor holds text inputs, and a Radix menu
 * steals the keystrokes a text input needs.
 */

import { useMemo, useState, type KeyboardEvent } from 'react';
import { Check, Pencil, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatLocaleNumber, localeCount, useTranslation } from '@/i18n';
import { normalizeModelTagName, type ModelTag } from '@/lib/model-tags/types';
import { ModelTagChip } from './ModelTagChip';

export interface ModelTagEditorProps {
  /** The model(s) the checkboxes act on. */
  modelIds: readonly string[];
  /** Display name when editing a single model. */
  modelName?: string;
  onClose: () => void;
}

type Membership = 'all' | 'some' | 'none';

export function ModelTagEditor({ modelIds: initialIds, modelName, onClose }: ModelTagEditorProps) {
  const { t, locale } = useTranslation();
  const { modelTags, assignments, models, createModelTag, renameModelTag, deleteModelTag, assignModelTags, unassignModelTags } =
    useViewerStore(
      useShallow((s) => ({
        modelTags: s.modelTags,
        assignments: s.modelTagAssignments,
        models: s.models,
        createModelTag: s.createModelTag,
        renameModelTag: s.renameModelTag,
        deleteModelTag: s.deleteModelTag,
        assignModelTags: s.assignModelTags,
        unassignModelTags: s.unassignModelTags,
      })),
    );
  // Bulk scope: the editor opened for one model can be widened to every model.
  const [bulk, setBulk] = useState(initialIds.length > 1);
  const modelIds = useMemo(
    () => (bulk ? [...models.keys()] : [...initialIds]),
    [bulk, models, initialIds],
  );
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string; hasError?: boolean } | null>(null);

  const tags = useMemo(() => [...modelTags.values()].sort((a, b) => a.name.localeCompare(b.name)), [modelTags]);
  const membershipOf = (tagId: string): Membership => {
    const n = modelIds.filter((m) => assignments.get(m)?.has(tagId)).length;
    return n === 0 ? 'none' : n === modelIds.length ? 'all' : 'some';
  };
  const suggestions = useMemo(() => {
    const q = normalizeModelTagName(draft);
    if (!q) return [];
    return tags.filter((t) => normalizeModelTagName(t.name).includes(q)).slice(0, 8);
  }, [draft, tags]);
  const exact = tags.find((t) => normalizeModelTagName(t.name) === normalizeModelTagName(draft));

  const addDraft = (name = draft) => {
    const id = createModelTag(name);
    if (!id) return;
    assignModelTags(modelIds, [id]);
    setDraft('');
  };
  const onDraftKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); addDraft(); }
    if (e.key === 'Escape' && draft) { e.preventDefault(); setDraft(''); }
  };
  const toggle = (tag: ModelTag) => {
    if (membershipOf(tag.id) === 'all') unassignModelTags(modelIds, [tag.id]);
    else assignModelTags(modelIds, [tag.id]);
  };
  const commitRename = () => {
    if (!renaming) return;
    if (renameModelTag(renaming.id, renaming.name)) setRenaming(null);
    else setRenaming({ ...renaming, hasError: true });
  };

  const description = bulk
    ? t('hierarchy.modelTagEditor.descriptionAll', { countDisplay: formatLocaleNumber(locale, modelIds.length) })
    : modelName
      ? t('hierarchy.modelTagEditor.descriptionNamed', { name: modelName })
      : modelIds.length === 1
        ? t('hierarchy.modelTagEditor.descriptionThisModel')
        : t('hierarchy.modelTagEditor.descriptionCount', localeCount(locale, modelIds.length));

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md" data-model-tag-editor>
        <DialogHeader>
          <DialogTitle>{t('hierarchy.modelTagEditor.title')}</DialogTitle>
          <DialogDescription>
            {description}
          </DialogDescription>
        </DialogHeader>

        {models.size > 1 && (
          <div
            className="inline-flex overflow-hidden rounded-md border border-border text-[11px]"
            role="group"
            aria-label={t('hierarchy.modelTagEditor.applyToAriaLabel')}
          >
            <button type="button" onClick={() => setBulk(false)} className={cn('px-2 py-0.5', !bulk && 'bg-muted font-medium')}>
              {modelName ?? t('hierarchy.modelTagEditor.selected')}
            </button>
            <button type="button" onClick={() => setBulk(true)} className={cn('px-2 py-0.5', bulk && 'bg-muted font-medium')}>
              {t('hierarchy.modelTagEditor.allModels', { countDisplay: formatLocaleNumber(locale, models.size) })}
            </button>
          </div>
        )}

        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onDraftKey}
              placeholder={t('hierarchy.modelTagEditor.addPlaceholder')}
              aria-label={t('hierarchy.modelTagEditor.addAriaLabel')}
              className="h-8 text-sm"
              autoFocus
            />
            <Button type="button" size="sm" className="h-8" disabled={!draft.trim()} onClick={() => addDraft()}>
              {exact ? t('hierarchy.modelTagEditor.assign') : t('hierarchy.modelTagEditor.create')}
            </Button>
          </div>
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1" aria-label={t('hierarchy.modelTagEditor.matchingTagsAriaLabel')}>
              {suggestions.map((suggestion) => (
                <button key={suggestion.id} type="button" onClick={() => addDraft(suggestion.name)} className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted">
                  {suggestion.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <ul className="max-h-64 space-y-0.5 overflow-y-auto" aria-label={t('hierarchy.modelTagEditor.allTagsAriaLabel')}>
          {tags.length === 0 && (
            <li className="px-1 py-2 text-xs italic text-muted-foreground">{t('hierarchy.modelTagEditor.emptyState')}</li>
          )}
          {tags.map((tag) => {
            const membership = membershipOf(tag.id);
            const isRenaming = renaming?.id === tag.id;
            return (
              <li key={tag.id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted/60" data-tag-row={tag.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={membership === 'all' ? 'true' : membership === 'some' ? 'mixed' : 'false'}
                  aria-label={t(
                    membership === 'all'
                      ? 'hierarchy.modelTagEditor.removeTagAriaLabel'
                      : 'hierarchy.modelTagEditor.assignTagAriaLabel', {
                    name: tag.name,
                  })}
                  onClick={() => toggle(tag)}
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border text-[10px]',
                    membership !== 'none' && 'bg-primary text-primary-foreground',
                  )}
                >
                  {membership === 'all' ? <Check className="h-3 w-3" /> : membership === 'some' ? '–' : ''}
                </button>
                {isRenaming ? (
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <Input
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: tag.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                        if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                      }}
                      aria-label={t('hierarchy.modelTagEditor.renameAriaLabel', { name: tag.name })}
                      className="h-7 text-xs"
                      autoFocus
                    />
                    {renaming.hasError && <span role="alert" className="text-[10px] text-red-600">{t('hierarchy.modelTagEditor.renameError')}</span>}
                  </div>
                ) : (
                  <span className="min-w-0 flex-1"><ModelTagChip tag={tag} /></span>
                )}
                <button
                  type="button"
                  aria-label={
                    isRenaming
                      ? t('hierarchy.modelTagEditor.saveNameAriaLabel', { name: tag.name })
                      : t('hierarchy.modelTagEditor.renameAriaLabel', { name: tag.name })
                  }
                  onClick={() => (isRenaming ? commitRename() : setRenaming({ id: tag.id, name: tag.name }))}
                  className="p-0.5 text-zinc-400 hover:text-foreground"
                >
                  {isRenaming ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  aria-label={t('hierarchy.modelTagEditor.deleteAriaLabel', { name: tag.name })}
                  title={t('hierarchy.modelTagEditor.deleteTooltip')}
                  onClick={() => deleteModelTag(tag.id)}
                  className="p-0.5 text-zinc-400 hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
