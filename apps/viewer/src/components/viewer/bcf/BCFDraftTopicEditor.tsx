/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Review one draft topic: fields, assignee from the server's user list, members, split and comments (#6896). */

import { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n';
import { addDraftComment, deleteDraftTopic, editDraftTopic, removeDraftMember, splitDraftTopic, type DraftEditResult, type DraftFieldEdit }
  from '@/lib/bcf-drafts/draft-edit';
import { findingIdentity, type DraftBatch, type DraftTopic } from '@/lib/bcf-drafts/draft-types';

export interface BCFDraftTopicEditorProps {
  batch: DraftBatch;
  topic: DraftTopic;
  /** Users from the selected server project's `user_id_type`; empty until a project is checked. */
  users: readonly string[];
  /** Server status of this topic's publication, if any. */
  publication?: string;
  mergeSelected: boolean;
  onToggleMerge: (guid: string) => void;
  onEdit: (result: DraftEditResult | Promise<DraftEditResult>) => void;
}

function FieldInput({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  return <label className="flex min-w-0 flex-col gap-0.5 text-2xs text-muted-foreground">
    {label}
    <Input className="h-7 text-xs" value={draft} onChange={event => setDraft(event.target.value)}
      onBlur={() => { if (draft.trim() !== value) onCommit(draft.trim()); }} />
  </label>;
}

export function BCFDraftTopicEditor({ batch, topic, users, publication, mergeSelected, onToggleMerge, onEdit }: BCFDraftTopicEditorProps) {
  const { t } = useTranslation();
  const [splitSet, setSplitSet] = useState<Set<string>>(new Set());
  const [comment, setComment] = useState('');
  const field = (edit: DraftFieldEdit) => onEdit(editDraftTopic(batch, topic.guid, edit));
  const assignees = topic.assignedTo && !users.includes(topic.assignedTo) ? [topic.assignedTo, ...users] : users;
  return (
    <section className="rounded-md border border-border p-2 text-xs" aria-label={t('bcfDrafts.topic.region', { title: topic.title })}>
      <div className="flex items-start gap-2">
        <input type="checkbox" className="mt-2" checked={mergeSelected} onChange={() => onToggleMerge(topic.guid)}
          aria-label={t('bcfDrafts.topic.selectForMerge', { title: topic.title })} />
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-1 sm:grid-cols-4">
          <div className="col-span-2"><FieldInput key={`t${topic.title}`} label={t('bcfDrafts.topic.title')} value={topic.title} onCommit={title => title && field({ title })} /></div>
          <FieldInput key={`s${topic.topicStatus}`} label={t('bcfDrafts.topic.status')} value={topic.topicStatus} onCommit={topicStatus => topicStatus && field({ topicStatus })} />
          <FieldInput key={`p${topic.priority}`} label={t('bcfDrafts.topic.priority')} value={topic.priority ?? ''} onCommit={priority => field({ priority })} />
          <FieldInput key={`y${topic.topicType}`} label={t('bcfDrafts.topic.type')} value={topic.topicType} onCommit={topicType => topicType && field({ topicType })} />
          <label className="col-span-1 flex min-w-0 flex-col gap-0.5 text-2xs text-muted-foreground sm:col-span-3">
            {t('bcfDrafts.topic.assignee')}
            <select className="h-7 rounded border border-border bg-background text-xs" value={topic.assignedTo ?? ''}
              disabled={assignees.length === 0} onChange={event => field({ assignedTo: event.target.value })}>
              <option value="">{assignees.length ? t('bcfDrafts.topic.unassigned') : t('bcfDrafts.topic.noUsers')}</option>
              {assignees.map(user => <option key={user} value={user}>{user}</option>)}
            </select>
          </label>
        </div>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={t('bcfDrafts.topic.delete', { title: topic.title })}
          onClick={() => onEdit(deleteDraftTopic(batch, topic.guid))}><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>
      {publication && <output className="mt-1 block text-2xs text-muted-foreground">{publication}</output>}
      <details className="mt-1">
        <summary className="cursor-pointer">{t('bcfDrafts.topic.members', { count: topic.members.length })}</summary>
        <ul className="mt-1 flex flex-col gap-0.5">
          {topic.members.map(member => {
            const identity = findingIdentity(member);
            const label = `${member.a.name ?? member.a.tag} ↔ ${member.b.name ?? member.b.tag} · ${member.rule}`;
            return <li key={identity} className="flex items-center gap-1">
              <input type="checkbox" checked={splitSet.has(identity)} aria-label={t('bcfDrafts.topic.selectForSplit', { member: label })}
                onChange={() => setSplitSet(current => { const next = new Set(current); if (!next.delete(identity)) next.add(identity); return next; })} />
              <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
              <Button size="sm" variant="ghost" className="h-5 w-5 p-0" aria-label={t('bcfDrafts.topic.removeMember', { member: label })}
                onClick={() => onEdit(removeDraftMember(batch, topic.guid, identity))}><X className="h-3 w-3" /></Button>
            </li>;
          })}
        </ul>
        <Button size="sm" variant="outline" className="mt-1 h-6 px-2 text-2xs"
          disabled={splitSet.size === 0 || splitSet.size === topic.members.length}
          onClick={() => { onEdit(splitDraftTopic(batch, topic.guid, splitSet)); setSplitSet(new Set()); }}>
          {t('bcfDrafts.topic.split', { count: splitSet.size })}
        </Button>
      </details>
      {topic.comments.length > 0 && <ul className="mt-1 list-disc pl-4 text-2xs">{topic.comments.map(item => <li key={item.id}>{item.text}</li>)}</ul>}
      <form className="mt-1 flex gap-1" onSubmit={event => {
        event.preventDefault();
        if (!comment.trim()) return;
        onEdit(addDraftComment(batch, topic.guid, comment));
        setComment('');
      }}>
        <Input className="h-7 text-xs" value={comment} onChange={event => setComment(event.target.value)}
          aria-label={t('bcfDrafts.topic.commentLabel', { title: topic.title })} placeholder={t('bcfDrafts.topic.commentPlaceholder')} />
        <Button size="sm" variant="outline" className="h-7 px-2 text-2xs" type="submit" disabled={!comment.trim()}>{t('bcfDrafts.topic.addComment')}</Button>
      </form>
    </section>
  );
}
