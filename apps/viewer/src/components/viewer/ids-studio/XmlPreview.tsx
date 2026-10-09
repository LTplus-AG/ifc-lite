/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The XML tab (IDS-037): the document as the shared IDS writer emits it, in a
 * read-only CodeMirror view. The selected node's element is highlighted and
 * scrolled into view; the view follows every edit.
 */

import { useEffect, useMemo, useRef } from 'react';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers, type DecorationSet } from '@codemirror/view';
import type { StudioDocument } from '@ifc-lite/ids-authoring';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { studioXml, xmlRangeOf, type XmlRange } from '@/lib/ids-studio/xml';

const setHighlight = StateEffect.define<XmlRange | null>();
const highlightMark = Decoration.mark({ class: 'cm-ids-selected' });

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setHighlight)) {
        next = effect.value && effect.value.to > effect.value.from ? Decoration.set([highlightMark.range(effect.value.from, effect.value.to)]) : Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.theme({
  '&': { fontSize: '11px', height: '100%', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflow: 'auto' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
  '.cm-ids-selected': { backgroundColor: 'rgba(59, 130, 246, 0.18)' },
});

const EXTENSIONS: Extension[] = [lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping, highlightField, theme];

export function XmlPreview({ doc }: { doc: StudioDocument }) {
  const { t } = useTranslation();
  const selection = useViewerStore((s) => s.idsStudioSelection);
  const host = useRef<HTMLElement>(null);
  const view = useRef<EditorView | null>(null);
  const xml = useMemo(() => studioXml(doc), [doc]);
  const text = xml.ok ? xml.xml : '';

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({ state: EditorState.create({ doc: '', extensions: EXTENSIONS }), parent: host.current });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const range = selection ? xmlRangeOf(text, doc, selection) : null;
    const current = editor.state.doc.toString();
    editor.dispatch({
      ...(current === text ? {} : { changes: { from: 0, to: current.length, insert: text } }),
      effects: setHighlight.of(range),
    });
    if (!range) return;
    // Scroll once the new content is laid out; in the same transaction as a
    // whole-document replace the target is measured against the old layout.
    const frame = requestAnimationFrame(() => {
      if (view.current === editor) editor.dispatch({ effects: EditorView.scrollIntoView(range.from, { y: 'center' }) });
    });
    return () => cancelAnimationFrame(frame);
  }, [text, doc, selection]);

  return <div className="flex h-full min-h-0 flex-col">
    {!xml.ok && <p role="alert" className="border-b border-border px-2 py-1 text-2xs text-destructive break-words">{t('idsStudio.xml.unwritable', { reason: xml.error })}</p>}
    <section ref={host} aria-label={t('idsStudio.xml.label')} className="min-h-0 flex-1 overflow-hidden" />
  </div>;
}
