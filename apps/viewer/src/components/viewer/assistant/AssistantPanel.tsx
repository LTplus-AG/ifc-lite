/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { History, Key, RefreshCw, Send, Sparkles, Square } from 'lucide-react';
import { ConversationLibrary } from './ConversationLibrary';
import { SourcePicker } from './SourcePicker';
import { useDialogs } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { ModelSelector } from '../chat/ModelSelector';
import { ByokKeyModal } from '../chat/ByokKeyModal';
import { useAssistant, cancelAssistant, replaceEvidence } from '@/lib/assistant/conversation';
import { captureEvidence, evidenceIsCurrent, type AssistantSource } from '@/lib/assistant/evidence';
import { ASSISTANT_PROXY_URL, sendAssistant } from '@/lib/assistant/request';
import { adapterFor } from '@/lib/assistant/adapters/registry';
import { isFlowSource, isReportSource } from '@/lib/assistant/sources';
import { resolveCapturedClash } from '@/lib/assistant/clash-group-proposal';
import { useClash } from '@/hooks/useClash';
import { EvidenceSummary } from './EvidenceSummary';
import { AssistantConversation } from './AssistantConversation';
import { FreeQuotaNote } from './AssistantUsage';
