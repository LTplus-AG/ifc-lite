# @ifc-lite/source-bimcollab

BIMcollab Documents `FileSourceProvider` for IFC, IFCZIP, IFCXML and IFCX.
The host supplies its existing BCF session; this package never starts OAuth or
stores tokens. A 401 throws `BimcollabHttpError` with
`reauthenticationRequired: true`; a 403 means no document access in the space.

```ts
import {
  BimcollabProvider, RelayBimcollabTransport,
  spaceIdFromAccessToken, spaceLabelFromServerUrl,
} from '@ifc-lite/source-bimcollab';

// Host callbacks, backed by the existing BCF login and refresh lifecycle.
const session = {
  spaceGuid: spaceIdFromAccessToken(await getAccessToken()),
  spaceLabel: spaceLabelFromServerUrl(savedBcfServerUrl),
  getAccessToken,
};
const provider = new BimcollabProvider({
  session,
  transport: new RelayBimcollabTransport('/api/bimcollab', approvedRelayFetch),
  legacyDownloadFallback: true,
});
```

`spaceIdFromAccessToken` decodes claims only; it does not authenticate a JWT.
Invalid input returns an empty string. The URL helper accepts a single space
label under HTTPS `bimcollab.com`. The constructor rejects invalid session ids.

The default transport uses `ctx.fetch` and `/api/bimcollab`; a host that validates
only upstream URLs (including the current viewer SourceHost) must inject a
host-approved same-origin fetch as shown above. Its upstream rewrite alone
cannot express the relay's two route families. Register the provider only when
a BIMcollab BCF session is available; surface login/refresh through that existing
host flow. Manifest auth is `preferences` with no fields because the host owns
authentication. No separate interactive auth UI is declared. Viewer registration
and relay implementation are separate tasks.

Relay requests carry bearer authorization, omit cookies, reject redirects and
forward abort signals. `docs/<spaceGuid>/…` serves the public Documents API;
`space/<label>/index?locationId=N` and `space/<label>/download/<versionId>` serve
the legacy workaround. SAS downloads use `ctx.fetchPublic`, without bearer
headers; the host must enforce credential omission and the public-network
allowlist. Progress reports actual bytes through `DownloadOptions.onProgress`.

Locations × projects map to projects with `locationId` and `locationName` metadata.
Phases become leaf containers; projects with no phases get a `root` container.
Listings page incrementally (maximum 100 raw documents); filtered pages may be
empty with a continuation cursor. Search uses project-level `searchText`.
Archived and confidential records are excluded. Revisions use public GUIDs.

On the specific public download-unavailable 404, the default fallback probes
numeric locations 1–10 sequentially by location/project name, caches the matching
index for 60 seconds, and requires exactly one document-number/version-number
match. It honors `allowDownload: false`. An inaccessible or ambiguous match fails
explicitly. The index exposes current versions: an older revision downloads only
if the public endpoint serves it or the index contains that exact version; the
provider never silently substitutes the latest bytes. Set
`legacyDownloadFallback: false` once BIMcollab fixes its public endpoint.

For Node/CLI, inject `new DirectBimcollabTransport(fetchFn)` (optional second
argument: regional HTTPS origin). This supports public API downloads without a
relay. Legacy web-app downloads require the relay transport.

`watchRevisions` is omitted: `newVersionSinceDateTime` reports new versions but
cannot establish deletions or reconcile an initial tracked-ref baseline. The
manifest therefore declares `changeDetection: false`.

Tests use fake fetch only; no BIMcollab account or network access is needed.
