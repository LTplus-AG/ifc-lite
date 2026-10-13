/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http";
import { GithubIssues, publicIssueBody } from "../src/github.js";
import type { Config } from "../src/config.js";
import type { ReportRow } from "../src/reports.js";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config: Config = {
  submissionsEnabled: true,
  origin: "https://viewer.example.com",
  port: 0,
  databaseUrl: "unused",
  bucket: "unused",
  region: "unused",
  accessKeyId: "unused",
  secretAccessKey: "unused",
  admissionSecret: "unused",
  adminToken: "unused",
  githubAppId: "123",
  githubInstallationId: "456",
  githubPrivateKey: keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
  githubRepository: "owner/repo",
  storageProvider: "test",
  storageLocation: "test",
  backupDisclosure: "none",
  agreement: {
    version: "draft",
    sha256: "",
    text: "",
    issuer: "LTplus AG",
    jurisdiction: "Switzerland",
    signingEnabled: false,
  },
  maxDailyReports: 1,
  maxDailyBytes: 1,
  maxStorageBytes: 1,
};
function report(id: string): ReportRow {
  return {
    id,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 86400000),
    session_id: "owner",
    draft: {
      clientRequestId: id,
      title: "Reviewed report",
      description: `Evidence for ${id}`,
      diagnostics: {
        errorCode: "generic_error",
        appVersion: "1",
        buildSha: "abc",
      },
      visibility: "private",
    },
    status: "submitted",
    agreement: null,
    custom_nda: null,
    issue_url: null,
    fingerprint: `fingerprint-${id}`,
  };
}
const app = { id: 123, slug: "ifc-lite-reviewed-reports" };
// Actual issue-author shape from the synthetic live qualification (#7495).
const bot = { id: 341635942, login: "ifc-lite-reviewed-reports[bot]", type: "Bot" };
function identityResponse(url: URL, init?: RequestInit): Response | undefined {
  if (url.pathname === "/app") {
    const jwt = new Headers(init?.headers).get("Authorization")!.slice(7).split(".");
    expect(verify("RSA-SHA256", Buffer.from(`${jwt[0]}.${jwt[1]}`), keys.publicKey, Buffer.from(jwt[2]!, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(jwt[1]!, "base64url").toString()).iss).toBe(config.githubAppId);
    expect(init?.redirect).toBe("error");
    return Response.json(app);
  }
  if (url.pathname === "/users/ifc-lite-reviewed-reports%5Bbot%5D") {
    expect(init?.redirect).toBe("error");
    return Response.json(bot);
  }
  return undefined;
}
function parsedUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
}
// Real HTTP boundary: a successful create can lose its socket before any response.
async function httpBridge(transport: typeof fetch) {
  const errors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
        else if (value !== undefined) headers.set(key, value);
      }
      const response = await transport(`https://api.github.com${req.url}`, {
        method: req.method, headers, redirect: "error",
        ...(chunks.length ? { body: Buffer.concat(chunks).toString() } : {}),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      errors.push(error);
      res.destroy();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  const fetcher: typeof fetch = (input, init) => {
    const url = parsedUrl(input);
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
  };
  return { fetcher, errors, close: () => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }) };
}
describe("#7495 GitHub App transport and ambiguity recovery", () => {
  it("does not disclose attachment names or signed agreement identities in GitHub", () => {
    const row: ReportRow = {
      id: "report",
      created_at: new Date(),
      expires_at: new Date(Date.now() + 86400000),
      session_id: "owner",
      status: "draft",
      issue_url: null,
      draft: {
        clientRequestId: "125be751-2d65-4323-8f52-030926151929",
        title: "Error",
        description: "Reviewed description",
        diagnostics: { errorCode: "camera", appVersion: "1", buildSha: "abc" },
        visibility: "private",
      },
      fingerprint: "fingerprint",
      agreement: { signerEmail: "private@example.com" },
      custom_nda: null,
    };
    const text = publicIssueBody(row);
    expect(text).toContain("Reviewed description");
    expect(text).toContain("ifclite-report:report");
    expect(text).not.toContain("private@example.com");
  });
  it.each([null, { id: 123 }])("authenticates App JWT and reconciles a lost issue response with optional metadata %j without duplicates", async (metadata) => {
    const item = report("report-one");
    let saved: Record<string, unknown> | undefined;
    let creates = 0;
    const transport: typeof fetch = async (input, init) => {
      const url = parsedUrl(input);
      if (url.pathname === "/app/installations/456/access_tokens") {
        expect(init?.method).toBe("POST");
        const auth = new Headers(init?.headers).get("Authorization")!;
        const jwt = auth.slice(7).split(".");
        expect(
          verify(
            "RSA-SHA256",
            Buffer.from(`${jwt[0]}.${jwt[1]}`),
            keys.publicKey,
            Buffer.from(jwt[2]!, "base64url"),
          ),
        ).toBe(true);
        expect(
          JSON.parse(Buffer.from(jwt[1]!, "base64url").toString()).iss,
        ).toBe("123");
        return Response.json({ token: "installation-token" });
      }
      const identity = identityResponse(url, init); if (identity) return identity;
      expect(url.pathname).toBe("/repos/owner/repo/issues");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer installation-token",
      );
      if (init?.method === "POST") {
        creates++;
        saved = JSON.parse(String(init.body));
        expect(saved).toMatchObject({ title: item.draft.title });
        expect(String(saved?.body)).toContain(item.draft.description);
        throw new TypeError("network response lost after creation");
      }
      return Response.json(
        saved
          ? [
              {
                ...saved,
                html_url: "https://github.com/owner/repo/issues/10",
                created_at: new Date().toISOString(),
                performed_via_github_app: metadata,
                user: bot,
              },
            ]
          : [],
      );
    };
    const bridge = await httpBridge(transport);
    try {
      const github = new GithubIssues(config, bridge.fetcher);
      await expect(github.findOrCreate(item, async () => {})).rejects.toThrow();
      expect(await github.findOrCreate(item, async () => {})).toBe("https://github.com/owner/repo/issues/10");
      expect(creates).toBe(1);
      expect(bridge.errors.map(String)).toEqual(["TypeError: network response lost after creation"]);
    } finally { await bridge.close(); }
  });
  it("does not accept a marker forged by another App or collapse another reviewed report", async () => {
    const first = report("first");
    const second = report("second");
    const bodies: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = parsedUrl(input);
      if (url.pathname.includes("/access_tokens"))
        return Response.json({ token: "token" });
      const identity = identityResponse(url, init); if (identity) return identity;
      if (init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        bodies.push(payload.body);
        return Response.json({
          html_url: `https://github.com/owner/repo/issues/${bodies.length}`,
        });
      }
      return Response.json([
        {
          body: publicIssueBody(first),
          created_at: new Date().toISOString(),
          performed_via_github_app: { id: 999 },
          user: bot,
          html_url: "https://github.com/owner/repo/issues/99",
        },
        ...bodies.map((body, index) => ({
          body, created_at: new Date().toISOString(), performed_via_github_app: null,
          user: bot, html_url: `https://github.com/owner/repo/issues/${index + 1}`,
        })),
      ]);
    };
    const github = new GithubIssues(config, transport);
    await github.findOrCreate(first, async () => {});
    await github.findOrCreate(second, async () => {});
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("Evidence for first");
    expect(bodies[1]).toContain("Evidence for second");
  });
  it("does not treat markers quoted in another App-created report as its own receipt", async () => {
    const original = report("original");
    const other = report("other");
    other.draft.description = publicIssueBody(original);
    let creates = 0;
    const transport: typeof fetch = async (input, init) => {
      if (parsedUrl(input).pathname.includes("/access_tokens")) return Response.json({ token: "token" });
      const identity = identityResponse(parsedUrl(input), init); if (identity) return identity;
      if (init?.method === "POST") {
        creates++;
        expect(JSON.parse(String(init.body)).body).toBe(publicIssueBody(original));
        return Response.json({ html_url: "https://github.com/owner/repo/issues/2" });
      }
      return Response.json([{ body: publicIssueBody(other), created_at: new Date().toISOString(), performed_via_github_app: { id: 123 }, user: bot, html_url: "https://github.com/owner/repo/issues/1" }]);
    };
    expect(await new GithubIssues(config, transport).findOrCreate(original, async () => {})).toBe("https://github.com/owner/repo/issues/2");
    expect(creates).toBe(1);
  });

  it.each([
    { label: "same login, wrong numeric ID", user: { ...bot, id: 77 }, metadata: null },
    { label: "same ID, foreign login", user: { ...bot, login: "foreign[bot]" }, metadata: null },
    { label: "non-Bot author", user: { ...bot, type: "User" }, metadata: null },
    { label: "string author ID", user: { ...bot, id: String(bot.id) }, metadata: null },
    { label: "missing author despite matching App metadata", user: null, metadata: { id: app.id } },
    { label: "contradictory App metadata", user: bot, metadata: { id: 999 } },
  ])("#7495 rejects $label rather than reconciling a forged footer", async ({ user, metadata }) => {
    const item = report("trusted-author"); let creates = 0;
    const transport: typeof fetch = async (input, init) => {
      const url = parsedUrl(input);
      if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "token" });
      const identity = identityResponse(url, init); if (identity) return identity;
      if (init?.method === "POST") { creates++; return Response.json({ html_url: "https://github.com/owner/repo/issues/20" }); }
      return Response.json([{ user, performed_via_github_app: metadata, body: publicIssueBody(item), created_at: new Date().toISOString(), html_url: "https://github.com/owner/repo/issues/19" }]);
    };
    expect(await new GithubIssues(config, transport).findOrCreate(item, async () => {})).toBe("https://github.com/owner/repo/issues/20");
    expect(creates).toBe(1);
  });

  it.each([
    { label: "foreign authenticated App", app: { ...app, id: 999 }, user: bot },
    { label: "unsafe App slug", app: { ...app, slug: "../foreign" }, user: bot },
    { label: "non-numeric bot ID", app, user: { ...bot, id: "341635942" } },
    { label: "wrong canonical bot login", app, user: { ...bot, login: "other[bot]" } },
    { label: "non-Bot canonical user", app, user: { ...bot, type: "User" } },
  ])("#7495 holds publication when identity resolution returns $label", async ({ app: returnedApp, user }) => {
    const repositoryRequests: string[] = [];
    const transport: typeof fetch = async (input) => {
      const url = parsedUrl(input);
      if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "token" });
      if (url.pathname === "/app") return Response.json(returnedApp);
      if (url.pathname.startsWith("/users/")) return Response.json(user);
      repositoryRequests.push(url.pathname); return Response.json([]);
    };
    await expect(new GithubIssues(config, transport).findOrCreate(report("identity-failure"), async () => {})).rejects.toThrow(/github_(app|bot)_identity_invalid/);
    expect(repositoryRequests).toEqual([]);
  });

  it.each(["/app", "/users/ifc-lite-reviewed-reports%5Bbot%5D"])(
    "#7495 holds publication when identity endpoint %s is unavailable",
    async (failedPath) => {
      let repositoryRequests = 0;
      const transport: typeof fetch = async (input, init) => {
        const url = parsedUrl(input);
        if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "token" });
        if (url.pathname === failedPath) return Response.json({}, { status: 503 });
        const identity = identityResponse(url, init);
        if (identity) return identity;
        repositoryRequests++;
        return Response.json([]);
      };
      await expect(new GithubIssues(config, transport).findOrCreate(report("unavailable"), async () => {}))
        .rejects.toThrow(/github_(app|bot)_identity_unavailable/);
      expect(repositoryRequests).toBe(0);
    },
  );

  it.each(["https://github.com/other/repo/issues/1", "https://github.com/owner/repo/issues/01", "https://github.com/owner/repo/pull/1"])(
    "#7495 rejects a create receipt outside the exact configured issue destination: %s", async (html_url) => {
      const transport: typeof fetch = async (input, init) => {
        const url = parsedUrl(input);
        if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "token" });
        const identity = identityResponse(url, init); if (identity) return identity;
        expect(init?.redirect).toBe("error");
        return Response.json(init?.method === "POST" ? { html_url } : []);
      };
      await expect(new GithubIssues(config, transport).findOrCreate(report("moved"), async () => {})).rejects.toThrow("github_create_invalid");
    },
  );
  it("#7495 does not follow an HTTP redirect when posting reviewed content", async () => {
    let redirectsFollowed = 0;
    const bridge = await httpBridge(async (input, init) => {
      const url = parsedUrl(input);
      if (url.pathname === "/unexpected") { redirectsFollowed++; return Response.json({}); }
      if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "token" });
      const identity = identityResponse(url, init); if (identity) return identity;
      return init?.method === "POST" ? new Response(null, { status: 307, headers: { Location: "/unexpected" } }) : Response.json([]);
    });
    try {
      await expect(new GithubIssues(config, bridge.fetcher).findOrCreate(report("redirect"), async () => {})).rejects.toThrow();
      expect(redirectsFollowed).toBe(0);
      expect(bridge.errors).toEqual([]);
    } finally { await bridge.close(); }
  });

  it.each([
    { label: "canonical bot with null metadata", user: bot, metadata: null, reconciles: true },
    { label: "foreign author with matching App metadata", user: { ...bot, id: 77 }, metadata: { id: app.id }, reconciles: false },
    { label: "canonical bot with contradictory metadata", user: bot, metadata: { id: 999 }, reconciles: false },
  ])("#7495 real HTTP comment recovery trusts $label", async ({ user, metadata, reconciles }) => {
    const item = report("comment-author");
    const issueUrl = "https://github.com/owner/repo/issues/7495";
    let posts = 0, authorizations = 0;
    const bridge = await httpBridge(async (input, init) => {
      const url = parsedUrl(input);
      if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "token" });
      const identity = identityResponse(url, init); if (identity) return identity;
      if (url.pathname.endsWith("/comments")) {
        if (init?.method === "POST") { posts++; return Response.json({ html_url: issueUrl + "#issuecomment-1" }); }
        return Response.json([{ body: publicIssueBody(item), user, performed_via_github_app: metadata }]);
      }
      return Response.json({ html_url: issueUrl, state: "open", title: "Reviewed target" });
    });
    const authorize = async () => { authorizations++; throw new Error("github_publication_review_required"); };
    try {
      const publication = new GithubIssues(config, bridge.fetcher).addToIssue(item, issueUrl, authorize);
      if (reconciles) await expect(publication).resolves.toBe(issueUrl);
      else await expect(publication).rejects.toThrow("github_publication_review_required");
      expect(authorizations).toBe(reconciles ? 0 : 1);
      expect(posts).toBe(0);
      expect(bridge.errors).toEqual([]);
    } finally { await bridge.close(); }
  });

  it.each(['issue', 'comment'])(
    '#7495 real HTTP %s reconciliation follows a short page advertising next without another POST', async destination => {
      const item = report(`short-page-${destination}`);
      const issueUrl = 'https://github.com/owner/repo/issues/7495';
      const pages: number[] = [];
      let posts = 0, authorizations = 0;
      const bridge = await httpBridge(async (input, init) => {
        const url = parsedUrl(input);
        if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 'token' });
        const identity = identityResponse(url, init); if (identity) return identity;
        if (url.pathname === '/repos/owner/repo/issues/7495') return Response.json({ html_url: issueUrl, state: 'open', title: 'Reviewed target' });
        if (init?.method === 'POST') {
          posts++;
          return Response.json({ html_url: destination === 'comment' ? `${issueUrl}#issuecomment-1` : issueUrl });
        }
        // Even a repository-ID alias in Link is not followed with credentials.
        expect(url.origin).toBe('https://api.github.com');
        expect(url.pathname).toBe(destination === 'comment' ? '/repos/owner/repo/issues/7495/comments' : '/repos/owner/repo/issues');
        const page = Number(url.searchParams.get('page')); pages.push(page);
        if (page === 1) return Response.json(Array.from({ length: 99 }, (_, id) => ({
          id, body: 'Unrelated comment', created_at: item.created_at.toISOString(), user: bot,
        })), { headers: { Link: `<https://api.github.com/repositories/1131742715/issues${destination === 'comment' ? '/7495/comments' : ''}?per_page=100&page=2>; rel="next"` } });
        expect(page).toBe(2);
        return Response.json([{ body: publicIssueBody(item), html_url: issueUrl,
          created_at: item.created_at.toISOString(), user: bot, performed_via_github_app: null }]);
      });
      const authorize = async () => { authorizations++; throw new Error('github_publication_review_required'); };
      try {
        const github = new GithubIssues(config, bridge.fetcher);
        await expect(destination === 'comment' ? github.addToIssue(item, issueUrl, authorize) : github.findOrCreate(item, authorize)).resolves.toBe(issueUrl);
        expect(pages).toEqual([1, 2]); expect(posts).toBe(0); expect(authorizations).toBe(0);
        expect(bridge.errors).toEqual([]);
      } finally { await bridge.close(); }
    },
  );

  it.each([
    { destination: 'issue', remaining: false }, { destination: 'comment', remaining: false },
    { destination: 'issue', remaining: true }, { destination: 'comment', remaining: true },
  ])('#7495 real HTTP $destination scan remains bounded and completes exactly ten full pages (next=$remaining)', async ({ destination, remaining }) => {
    const item = report(`bounded-${destination}-${remaining}`);
    const issueUrl = 'https://github.com/owner/repo/issues/7495';
    let pages = 0, posts = 0, authorizations = 0;
    const bridge = await httpBridge(async (input, init) => {
      const url = parsedUrl(input);
      if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 'token' });
      const identity = identityResponse(url, init); if (identity) return identity;
      if (url.pathname === '/repos/owner/repo/issues/7495') return Response.json({ html_url: issueUrl, state: 'open', title: 'Reviewed target' });
      if (init?.method === 'POST') { posts++; return Response.json({ html_url: destination === 'comment' ? `${issueUrl}#issuecomment-1` : issueUrl }); }
      const page = Number(url.searchParams.get('page')); pages++;
      expect(page).toBeLessThanOrEqual(10);
      const entries = Array.from({ length: 100 }, (_, id) => ({ id, body: 'Unrelated', created_at: item.created_at.toISOString(), user: bot }));
      return Response.json(entries, page < 10 || remaining ? { headers: { Link: `<https://api.github.com${url.pathname}?per_page=100&page=${page + 1}>; rel="next"` } } : undefined);
    });
    try {
      const github = new GithubIssues(config, bridge.fetcher);
      const authorize = async () => { authorizations++; };
      const result = destination === 'comment' ? github.addToIssue(item, issueUrl, authorize) : github.findOrCreate(item, authorize);
      if (remaining) await expect(result).rejects.toThrow(destination === 'comment' ? 'github_comment_reconciliation_limit' : 'github_reconciliation_limit');
      else await expect(result).resolves.toBe(issueUrl);
      expect(pages).toBe(10); expect(posts).toBe(remaining ? 0 : 1); expect(authorizations).toBe(remaining ? 0 : 1);
      expect(bridge.errors).toEqual([]);
    } finally { await bridge.close(); }
  });

});
