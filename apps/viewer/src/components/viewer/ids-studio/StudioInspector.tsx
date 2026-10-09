/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The inspector shows the selected node: document info, a specification or a facet (IDS-032/033). */

import { locateNode, type StudioDocument } from '@ifc-lite/ids-authoring';
import { useViewerStore } from '@/store';
import { DocumentInfoEditor } from './DocumentInfoEditor';
import { FacetEditor } from './FacetEditor';
import { SpecificationEditor } from './SpecificationEditor';

export function StudioInspector({ doc }: { doc: StudioDocument }) {
  const selection = useViewerStore((s) => s.idsStudioSelection);
  const loc = selection ? locateNode(doc, selection) : undefined;
  if (!selection || !loc || loc.kind === 'document' || loc.kind === 'constraint') return <DocumentInfoEditor doc={doc} />;
  if (loc.kind === 'spec') {
    return <SpecificationEditor key={loc.specId} spec={doc.ids.specifications[loc.specIndex]} specId={loc.specId} index={loc.specIndex} count={doc.ids.specifications.length} />;
  }
  return <FacetEditor key={selection} doc={doc} specIndex={loc.specIndex} section={loc.section} facetIndex={loc.facetIndex} facetId={selection} />;
}
