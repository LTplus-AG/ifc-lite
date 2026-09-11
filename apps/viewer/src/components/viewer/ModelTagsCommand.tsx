/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Model Tags" from the command palette (#4215): the tag editor for the
 * active model, so tags can be put on a model in a ONE-model session too.
 * The hierarchy's Models section — where the row chips and the tag button
 * live — only exists once a federation has two models, and a coordinator
 * who tags "Structure" before adding the second file, or who reopens a
 * one-slot setup file, must still be able to see and edit it.
 *
 * Mounted once from `FederationSetupControls` (the tags travel in that
 * setup file) and driven by a window event, `ShareDialog`'s pattern, so the
 * palette entry stays a one-liner in the capped `CommandPalette`.
 */

import { useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { ModelTagEditor } from './hierarchy/ModelTagEditor';

export const EVENT_EDIT_MODEL_TAGS = 'ifc-lite:edit-model-tags';

export function ModelTagsCommand() {
  const [target, setTarget] = useState<{ modelId: string; modelName: string } | null>(null);

  useEffect(() => {
    const onEdit = () => {
      const { models, activeModelId } = useViewerStore.getState();
      const model = (activeModelId ? models.get(activeModelId) : undefined) ?? [...models.values()][0];
      if (!model) {
        toast.error('Open a model first — tags are put on loaded models.');
        return;
      }
      setTarget({ modelId: model.id, modelName: model.name });
    };
    window.addEventListener(EVENT_EDIT_MODEL_TAGS, onEdit);
    return () => window.removeEventListener(EVENT_EDIT_MODEL_TAGS, onEdit);
  }, []);

  if (!target) return null;
  return <ModelTagEditor modelIds={[target.modelId]} modelName={target.modelName} onClose={() => setTarget(null)} />;
}
