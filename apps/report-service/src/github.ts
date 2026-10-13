/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createSign } from "node:crypto";
import type { Config } from "./config.js";
import { authenticatedAppAuthor, hasTrustedAppAuthor } from "./github-author.js";
import type { ReportRow } from "./reports.js";
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function publicIssueBody(report: ReportRow): string {
  const d = report.draft.diagnostics;
  return `${report.draft.description}\n\n### Reviewed diagnostics\n\n${Object.entries(d).filter(([key]) => ["errorCode", "appVersion", "buildSha", "browser"].includes(key))
    .map(([key, value]) => `- ${key}: ${String(value).replace(/[\r\n]/g, " ")}`)
    .join(
      "\n",
    )}\n\nReport reference: \`${report.id}\`\n\n<!-- ifclite-report:${report.id} -->\n<!-- ifclite-error:${report.fingerprint} -->`;
}
export class GithubIssues {
  constructor(
    private readonly config: Config,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: this.config.githubAppId })}`;
    const signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(this.config.githubPrivateKey)
      .toString("base64url");
    return `${unsigned}.${signature}`;
  }
  private async token(): Promise<string> {
    const response = await this.fetcher(
      `https://api.github.com/app/installations/${this.config.githubInstallationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.jwt()}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error(`github_auth_${response.status}`);
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("token" in body) ||
      typeof body.token !== "string"
    )
      throw new Error("github_token_invalid");
    return body.token;
  }
  private validIssueUrl(value: string): boolean {
    const prefix = `https://github.com/${this.config.githubRepository}/issues/`;
    return value.startsWith(prefix) && /^[1-9]\d*$/.test(value.slice(prefix.length));
  }
  async findOrCreate(report: ReportRow, beforeCreate?: () => Promise<void>): Promise<string> {
    const token = await this.token();
    const author = await authenticatedAppAuthor(this.config, this.fetcher, this.jwt(), token);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
    // Search API indexing is asynchronous. Enumerate recent issues directly to
    // reconcile ambiguous create responses before allowing another POST.
    for (let page = 1; page <= 10; page++) {
      const response = await this.fetcher(
        `https://api.github.com/repos/${this.config.githubRepository}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
        { headers, signal: AbortSignal.timeout(20000), redirect: "error" },
      );
      if (!response.ok) throw new Error(`github_list_${response.status}`);
      const issues: unknown = await response.json();
      if (!Array.isArray(issues)) throw new Error("github_list_invalid");
      let reachedEarlierIssues = false;
      for (const issue of issues) {
        if (!issue || typeof issue !== "object") continue;
        if (
          "created_at" in issue &&
          typeof issue.created_at === "string" &&
          new Date(issue.created_at).getTime() <
            report.created_at.getTime() - 60000
        )
          reachedEarlierIssues = true;
        if (
          hasTrustedAppAuthor(issue, author) &&
          "body" in issue &&
          typeof issue.body === "string" &&
          // User descriptions may quote another report's marker. Only the
          // terminal service-authored footer identifies this report.
          issue.body.endsWith(`<!-- ifclite-report:${report.id} -->\n<!-- ifclite-error:${report.fingerprint} -->`) &&
          "html_url" in issue &&
          typeof issue.html_url === "string" &&
          this.validIssueUrl(issue.html_url) && !("pull_request" in issue)
        )
          return issue.html_url;
      }
      if (issues.length < 100 || reachedEarlierIssues) break;
      if (page === 10) throw new Error("github_reconciliation_limit");
    }
    if (!beforeCreate) throw new Error("github_publication_authorization_required");
    await beforeCreate();
    const response = await this.fetcher(
      `https://api.github.com/repos/${this.config.githubRepository}/issues`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: report.draft.title,
          body: publicIssueBody(report),
        }),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error(`github_create_${response.status}`);
    const issue: unknown = await response.json();
    if (
      !issue ||
      typeof issue !== "object" ||
      !("html_url" in issue) ||
      typeof issue.html_url !== "string" ||
      !this.validIssueUrl(issue.html_url) || "pull_request" in issue
    )
      throw new Error("github_create_invalid");
    return issue.html_url;
  }
}
