/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// BIMcollab Documents API — Phase 0 probe (see bimcollab-documents-api.md).
// Paste into DevTools on the viewer AFTER connecting to a BIMcollab space via
// BCF → server → BIMcollab. Read-only: it creates, uploads and changes nothing.
// The report holds no token, only claim NAMES and the results.
(async () => {
  const HOST = 'https://api.eu.bimcollab.com';
  const report = { origin: location.origin };
  const cfg = JSON.parse(localStorage.getItem('ifc-lite:bcf-server:v1') || 'null');
  if (!cfg?.accessToken) return console.error('No saved BCF connection — connect to BIMcollab first.');
  report.serverUrl = cfg.serverUrl;
  report.tokenExpiresInMin = cfg.tokenExpiresAt ? Math.round((cfg.tokenExpiresAt - Date.now()) / 60000) : null;

  // 1. Space-id claim
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let payload = {};
  try {
    const p = cfg.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    payload = JSON.parse(atob(p.padEnd(Math.ceil(p.length / 4) * 4, '=')));
  } catch { report.tokenIsJwt = false; }
  report.claimNames = Object.keys(payload);
  report.audience = payload.aud; report.scope = payload.scope; report.issuer = payload.iss;
  report.guidClaims = Object.fromEntries(Object.entries(payload)
    .filter(([, v]) => (Array.isArray(v) ? v : [v]).some((x) => typeof x === 'string' && GUID.test(x))));
  const spaceId = payload.spaceGuid ?? Object.entries(report.guidClaims).find(([k]) => /space/i.test(k))?.[1]
    ?? prompt('No *space* GUID claim found. GUID claims: ' + JSON.stringify(report.guidClaims) + '\nEnter the space id:');
  report.spaceId = Array.isArray(spaceId) ? spaceId[0] : spaceId;

  const base = `${HOST}/spaces/${report.spaceId}/documents/v1`;
  const api = async (path) => {
    const r = await fetch(base + path, { headers: { Authorization: `Bearer ${cfg.accessToken}`, Accept: 'application/json', 'bimcollab-space-guid': report.spaceId } });
    const body = await r.text();
    let json; try { json = JSON.parse(body); } catch { json = body.slice(0, 300); }
    return { status: r.status, json };
  };

  try {
    // 2. Entitlement + API CORS
    const structure = await api('/project-structure');
    report.projectStructure = structure.status;
    if (structure.status !== 200) { report.projectStructureError = structure.json; throw new Error('stop'); }
    const projects = (structure.json.locations ?? []).flatMap((l) => l.projects ?? []);
    report.projectCount = projects.length;

    // 3. Find an IFC document
    let found;
    for (const p of projects.slice(0, 10)) {
      const docs = await api(`/projects/${p.projectId}/documents?limit=100&offset=0`);
      report.firstDocumentsStatus ??= docs.status;
      if (docs.status !== 200) continue;
      report.sampleDocumentKeys ??= docs.json[0] && Object.keys(docs.json[0]);
      found = docs.json.find((d) => /\.ifc(zip|xml|x)?$/i.test(d.latestVersion?.fileName ?? ''));
      if (found) break;
    }
    report.ifcDocumentFound = !!found;
    if (!found) throw new Error('stop');
    report.ifcDocumentType = found.documentType;

    // 4. Download URL + blob CORS
    const dl = await api(`/documents/${found.documentId}/download`);
    report.downloadStatus = dl.status;
    if (dl.status !== 200) { report.downloadError = dl.json; throw new Error('stop'); }
    const blobUrl = new URL(dl.json.downloadUrl);
    report.blobHost = blobUrl.host;
    report.blobQueryKeys = [...blobUrl.searchParams.keys()];
    try {
      const ctl = new AbortController();
      const r = await fetch(blobUrl, { credentials: 'omit', signal: ctl.signal });
      report.blobFetch = { ok: true, status: r.status, contentLength: r.headers.get('content-length'), contentType: r.headers.get('content-type') };
      const reader = r.body.getReader(); const { value } = await reader.read(); ctl.abort();
      report.blobFetch.head = new TextDecoder().decode(value?.slice(0, 20));
    } catch (e) {
      report.blobFetch = { ok: false, error: String(e) }; // TypeError "Failed to fetch" ⇒ CORS blocked
    }
  } catch (e) {
    if (e.message !== 'stop') report.error = String(e);
  }

  // Regions: does a US host exist?
  for (const h of ['https://api.us.bimcollab.com', 'https://api.bimcollab.com']) {
    try { const r = await fetch(`${h}/spaces/${report.spaceId}/documents/v1/projects`); report[`probe ${h}`] = r.status; }
    catch (e) { report[`probe ${h}`] = String(e); }
  }

  const text = JSON.stringify(report, null, 2);
  console.log(text);
  try { await navigator.clipboard.writeText(text); console.log('Report copied to clipboard.'); } catch {}
})();
