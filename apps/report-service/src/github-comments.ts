/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isRecord } from '@ifc-lite/report-contract';
import type { Config } from './config.js';
import type { ReportRow } from './reports.js';
import { hasTrustedAppAuthor, type GithubAppAuthor } from './github-author.js';

export async function findOrCreateComment(config: Config, fetcher: typeof fetch, token: string, author: GithubAppAuthor, report: ReportRow, issueUrl: string, body: string, beforeCreate?: () => Promise<void>): Promise<string> {
  const number = issueUrl.split('/').at(-1)!;
  const endpoint = `https://api.github.com/repos/${config.githubRepository}/issues/${number}/comments`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
  const marker = `<!-- ifclite-report:${report.id} -->\n<!-- ifclite-error:${report.fingerprint} -->`;
  // GitHub comments enumerate in creation order. Never create after an incomplete
  // reconciliation window: old/high-volume issues must hold for maintainer review.
  for (let page = 1; page <= 10; page++) {
    const response = await fetcher(`${endpoint}?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error('github_comment_list_failed');
    const comments: unknown = await response.json();
    if (!Array.isArray(comments)) throw new Error('github_comment_list_invalid');
    for (const comment of comments) {
      if (isRecord(comment) && hasTrustedAppAuthor(comment, author) && typeof comment.body === 'string' && comment.body.endsWith(marker)) return issueUrl;
    }
    if (comments.length < 100) break;
    if (page === 10) throw new Error('github_comment_reconciliation_limit');
  }
  if (!beforeCreate) throw new Error('github_publication_authorization_required');
  await beforeCreate();
  const response = await fetcher(endpoint, { method: 'POST', headers, body: JSON.stringify({ body }), signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw new Error('github_comment_create_failed');
  const comment: unknown = await response.json();
  if (!isRecord(comment) || typeof comment.html_url !== 'string' || (!comment.html_url.startsWith(`${issueUrl}#issuecomment-`) || !/^[1-9]\d*$/.test(comment.html_url.slice(`${issueUrl}#issuecomment-`.length)))) throw new Error('github_comment_create_invalid');
  return issueUrl;
}
