/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's IDS-agent run (IDS-081/082/085/086): one run at a time, its
 * progress, the open clarification question, the proposal under review and
 * the selection the user is building. The agent itself (`@ifc-lite/ids-agent`)
 * is headless; this store is the only UI state.
 *
 * The schema tables and the agent load on first use, so the Assistant's
 * initial bundle does not carry them. Receipts go to the session receipt
 * log like every other Assistant request.
 */

import { create } from 'zustand';
import type { AgentRun, AskUserQuestion, Attachment } from '@ifc-lite/ids-agent';
import type { LintContext, StudioDocument } from '@ifc-lite/ids-authoring';
import { recordReceipt, type UsageReceipt } from '@/lib/llm/request-receipts';
import { idsDraftOf, type IdsDraft } from '@/lib/check-authoring/ids-draft';
import { idsAgentRoute } from './transport';

export type AgentRunPhase = 'idle' | 'running' | 'done';

export interface ProgressLine {
  kind: 'tool' | 'note';
  text: string;
  ok?: boolean;
}

interface IdsAgentState {
  phase: AgentRunPhase;
  /** Streamed model text of the current turn. */
  text: string;
  progress: ProgressLine[];
  question: AskUserQuestion | null;
  run: AgentRun | null;
  /** The document the run started from: what accepted batches are applied to. */
  base: StudioDocument | null;
  /** Batch ids the user keeps. */
  selection: ReadonlySet<string>;
  error: string | null;
}

const INITIAL: IdsAgentState = { phase: 'idle', text: '', progress: [], question: null, run: null, base: null, selection: new Set(), error: null };
const PROGRESS_LIMIT = 40;

export const useIdsAgent = create<IdsAgentState>(() => INITIAL);

let controller: AbortController | null = null;
let answer: ((choice: number | null) => void) | null = null;
let lintContext: Promise<LintContext> | null = null;

function push(line: ProgressLine): void {
  useIdsAgent.setState((s) => ({ progress: [...s.progress, line].slice(-PROGRESS_LIMIT) }));
}

async function contexts(): Promise<LintContext> {
  lintContext ??= import('@ifc-lite/ids-authoring').then((m) => m.createLintContext());
  return lintContext;
}

export interface StartOptions {
  request: string;
  model: string | null | undefined;
  /** Evidence the user attached to the conversation, sent as fenced untrusted data. */
  attachments?: readonly Attachment[];
  /** The document to edit; a new empty document when absent. */
  doc?: StudioDocument;
}

/** Start a Draft run. Resolves when the run ends; the store holds the outcome. */
export async function startIdsAgentRun(options: StartOptions): Promise<void> {
  if (useIdsAgent.getState().phase === 'running') return;
  const route = idsAgentRoute(options.model);
  if (route.kind !== 'ready') {
    useIdsAgent.setState({ ...INITIAL, error: route.kind });
    return;
  }
  controller = new AbortController();
  const signal = controller.signal;
  useIdsAgent.setState({ ...INITIAL, phase: 'running' });
  try {
    const [{ runAgent }, authoring, lint] = await Promise.all([import('@ifc-lite/ids-agent'), import('@ifc-lite/ids-authoring'), contexts()]);
    const doc = options.doc ?? authoring.createStudioDocument({ title: 'IDS draft' });
    useIdsAgent.setState({ base: doc });
    const run = await runAgent({
      transport: route.transport, model: route.model, route: route.route, mode: 'draft', request: options.request,
      attachments: options.attachments ?? [], doc, gate: lint.gate, lint, signal,
      askUser: (question, questionSignal) => new Promise<number | null>((resolve) => {
        answer = resolve;
        useIdsAgent.setState({ question });
        questionSignal.addEventListener('abort', () => resolve(null), { once: true });
      }),
      onEvent: (event) => {
        if (event.type === 'text') useIdsAgent.setState((s) => ({ text: s.text + event.delta }));
        else if (event.type === 'request') useIdsAgent.setState({ text: '' });
        else if (event.type === 'tool-result') push({ kind: 'tool', text: event.summary, ok: event.ok });
        // The agent's routes are the viewer's BYOK routes.
        else if (event.type === 'receipt') recordReceipt(event.receipt as UsageReceipt);
      },
    });
    useIdsAgent.setState({ phase: 'done', run, question: null, selection: new Set(run.proposal.batches.map((b) => b.id)) });
  } catch (error) {
    console.error('[IDS agent] run failed', error);
    useIdsAgent.setState({ phase: 'done', question: null, error: error instanceof Error ? error.message : String(error) });
  } finally {
    controller = null;
    answer = null;
  }
}

/**
 * The accepted part of the proposal as an IDS draft for the native gates:
 * the selected batches, re-gated and applied to the run's base document.
 */
export async function acceptedIdsDraft(): Promise<{ draft: IdsDraft; rejected: string[] }> {
  const { run, base, selection } = useIdsAgent.getState();
  if (!run || !base) throw new Error('There is no proposal to accept.');
  const [{ acceptProposal }, authoring, lint] = await Promise.all([import('@ifc-lite/ids-agent'), import('@ifc-lite/ids-authoring'), contexts()]);
  const { state, rejected } = acceptProposal(authoring.createStudioState(base), run.proposal, { gate: lint.gate, batchIds: selection });
  const unsupported = run.proposal.unresolved.map((u) => ({ text: u.statement, reason: `${u.category}: ${u.reason}` }));
  return { draft: idsDraftOf(state.doc.ids, unsupported), rejected: rejected.map((r) => r.batchId) };
}

export function cancelIdsAgentRun(): void {
  controller?.abort();
}

/** Answer the open clarification question (null: dismissed). */
export function answerIdsAgentQuestion(choice: number | null): void {
  const resolve = answer;
  answer = null;
  useIdsAgent.setState({ question: null });
  resolve?.(choice);
}

export function setIdsAgentSelection(selection: ReadonlySet<string>): void {
  useIdsAgent.setState({ selection });
}

export function resetIdsAgent(): void {
  cancelIdsAgentRun();
  useIdsAgent.setState(INITIAL);
}
