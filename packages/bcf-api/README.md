# @ifc-lite/bcf-api

REST client for [buildingSMART BCF API](https://github.com/buildingSMART/BCF-API) (OpenCDE) servers. Connects to a BCF server, authenticates via OAuth2, and pulls projects, topics, comments and viewpoints into the [`@ifc-lite/bcf`](https://www.npmjs.com/package/@ifc-lite/bcf) in-memory model — so server-hosted issues flow through the same code paths as imported `.bcfzip` files.

Works in the browser and in Node (uses the global `fetch`; injectable for tests). Implements the BCF API 2.1 routes.

## Install

```bash
npm install @ifc-lite/bcf-api @ifc-lite/bcf
```

## Sign in and pull a project

```ts
import {
  BcfApiClient,
  normalizeBcfBaseUrl,
  requestPasswordToken,
  fetchProjectAsBCF,
} from '@ifc-lite/bcf-api';

const baseUrl = normalizeBcfBaseUrl('https://example.com/bcf');

// Discover the token endpoint, then use the OAuth2 password grant
const auth = await new BcfApiClient({ baseUrl }).getAuthInfo();
const token = await requestPasswordToken({
  tokenUrl: auth.oauth2_token_url!,
  username: 'you@example.com',
  password: '...',
});

const client = new BcfApiClient({
  baseUrl,
  getAccessToken: () => token.access_token,
});

const projects = await client.getProjects();
const { project, warnings } = await fetchProjectAsBCF(client, projects[0].project_id);
// `project` is an @ifc-lite/bcf BCFProject: topics, comments, viewpoints
// (cameras, selection, coloring, visibility) and snapshots as data URLs.
```

`fetchProjectAsBCF` pages the topics collection (`$top`/`$skip`), fetches each topic's comments and viewpoints concurrently, resolves viewpoint components (inline or via the `/selection`, `/coloring`, `/visibility` subresources), and downloads snapshots. Per-item failures degrade to entries in `warnings` instead of failing the pull.

## Direct endpoint access

```ts
await client.getVersions();
await client.getCurrentUser();
await client.getExtensions(projectId);
await client.getTopics(projectId, { filter: "topic_status eq 'Open'", top: 50 });
await client.getComments(projectId, topicGuid);
await client.getViewpoint(projectId, topicGuid, viewpointGuid);
await client.getViewpointSnapshot(projectId, topicGuid, viewpointGuid); // Blob
await client.createTopic(projectId, { title: 'Clash at grid 3/C' });
await client.createComment(projectId, topicGuid, { comment: 'Fixed in rev B' });
```

Errors are `BcfApiError` (with `status`, `url` and `isAuthError`); token endpoint failures are `BcfAuthenticationError` (with the RFC 6749 `errorCode`). Refresh an expiring session with `refreshAccessToken({ tokenUrl, refreshToken })`.

## Other auth flows

Not every server offers the password grant. `requestClientCredentialsToken({ tokenUrl, clientId, clientSecret })` covers servers with OAuth application credentials (e.g. OpenProject), and a token obtained elsewhere (a server's own UI, an authorization-code flow you run yourself) plugs straight into `getAccessToken`.

## License

MPL-2.0
