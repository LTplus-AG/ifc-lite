/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Flow review checkpoints for AI node proposals (`FlowReviewCheckpoint.tsx`,
 * #6923). A lazy catalogue: it loads with the Flow panel and registers
 * itself (`lazy-catalogues.ts`), so it adds nothing to the page's first load.
 */
export const flowReviewEn = {
  'flowReview.title': 'Review AI proposal',
  'flowReview.paused': { one: 'The run paused at {nodes}. Nothing downstream of it runs until you approve this proposal.', other: 'The run paused at {nodes}. Nothing downstream of them runs until you approve this proposal.' },
  'flowReview.node': '{node} ({type})',
  'flowReview.digest': 'Proposal {digest}',
  'flowReview.created': 'Saved for review {time}',
  'flowReview.coverage.classify': '{rows} rows · {classified} classified · {unknown} unknown · {failed} failed · {notSent} not sent · {requests} requests · model {model}',
  'flowReview.coverage.summarize': '{rows} rows · {sent} sent · {sections} sections · {uncited} uncited · {requests} requests · model {model}',
  'flowReview.coverage.extract': '{passages} passages · {sent} sent · {records} records · {unsupported} unsupported · {requests} requests · model {model}',
  'flowReview.approve': 'Approve and resume',
  'flowReview.resume': 'Resume',
  'flowReview.reject': 'Reject',
  'flowReview.dismiss': 'Dismiss',
  'flowReview.state.prepared': 'Nothing downstream has run. Approve to continue the run with exactly this proposal, or reject it.',
  'flowReview.state.reviewed': 'Approved. Resume runs the rest of the graph from exactly this proposal.',
  'flowReview.state.applying': 'Resuming from the approved proposal…',
  'flowReview.state.completed': 'Resumed from the approved proposal. Nodes that finished before the pause were restored, not run again, and no new AI request was sent for this proposal.',
  'flowReview.state.partial': 'The resume did not finish ({reason}). Downstream effects may be partial; this proposal cannot be resumed again. Run the graph again for a new review.',
  'flowReview.state.rejected': 'Rejected. Nothing downstream of the proposal ran.',
  'flowReview.refused.graph-changed': 'The graph or its Player inputs changed after this proposal was made. Run the graph again for a new review.',
  'flowReview.refused.sources-changed': 'The models or their edits changed after this proposal was made. Run the graph again for a new review.',
  'flowReview.refused.other': 'This proposal cannot be resumed: {reason}',
  'flowReview.notSaved': 'The proposal could not be saved for review, so nothing downstream ran: {reason}',
  'flowReview.needsModel': 'AI nodes use the model chosen for the Assistant. Choose a model, or add a key for it, to run this graph.',
} as const satisfies Record<string, TranslationValue>;
