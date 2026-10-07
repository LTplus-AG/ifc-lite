/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import type { ClashResult } from '@ifc-lite/clash';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { useClash } from '@/hooks/useClash';
import { manualClashOccurrenceKey } from '@/lib/clash/manual-groups';
import type { ClashGroupApplication } from '@/lib/clash/group-applications';
import { useAssistant } from '@/lib/assistant/conversation';
import { evidenceIsCurrent } from '@/lib/assistant/evidence';
import { normalizeClashGroupAnswer, prepareClashGroupPreview, type ClashGroupPreview, type NormalizedClashAnswer } from '@/lib/assistant/clash-group-proposal';
import { draftFromPreview, type ClashGroupDraft } from '@/lib/assistant/clash-group-draft';
import { draftFromClassification } from '@/lib/assistant/clash-classify-run';
import { EvidenceView } from '../analysis/EvidenceView';
import { proposalOf } from './AssistantConversation';
import { ClashGroupDraftEditor } from './ClashGroupDraftEditor';
import { ClashGroupApply } from './ClashGroupApply';
import { ClashGroupApplicationCard } from './ClashGroupApplicationCard';
import { ClashClassifyAll } from './ClashClassifyAll';

