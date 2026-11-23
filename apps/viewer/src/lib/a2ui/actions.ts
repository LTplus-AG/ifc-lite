/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Action routing. A2UI `event` actions never execute anything here: they
 * become a new user turn (`eventToFollowUp`). Function-call actions are run by
 * the A2UI core through the catalog's functions, which apply the policy gate.
 */

import type { ActionPayload } from '@a2ui/web_core/v1_0';
import { eventToFollowUp } from '@ifc-lite/a2ui';
import { useViewerStore } from '@/store';

/** `event` is the A2UI event name; absent for a plain follow-up question (`ask`). */
export type FollowUpHandler = (text: string, context: Record<string, unknown>, event?: string) => void;

const MAX_CONTEXT_CHARS = 2000;

export function routeAction(action: ActionPayload, onFollowUp: FollowUpHandler | undefined): void {
  if (!onFollowUp) return;
  const followUp = eventToFollowUp(action.name, action.context, action.userMessage);
  onFollowUp(followUp.userText, followUp.context, action.name);
}

/**
 * The chat forwards text only, so a follow-up's structured context travels as
 * one compact line after the user's words. The prompt itself is not repeated.
 */
export function composeFollowUpPrompt(text: string, context: Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'prompt'));
  if (Object.keys(rest).length === 0) return text;
  let json = JSON.stringify(rest);
  if (json.length > MAX_CONTEXT_CHARS) json = `${json.slice(0, MAX_CONTEXT_CHARS)}…`;
  return `${text}\n\n(context: ${json})`;
}

/** Continue a follow-up as the next user turn in the in-app chat. */
export const followUpToChat: FollowUpHandler = (text, context) => {
  useViewerStore.getState().queueChatPrompt(composeFollowUpPrompt(text, context));
};
