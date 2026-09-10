---
'@ifc-lite/viewer': patch
---

BCF browser sign-in against a BIMcollab space now sends the OAuth scope BIMcollab requires (#3900).

The `bimcollab` preset declared no `oauthScope`, and `createAuthorizationRequest` writes the parameter only when one is set, so the authorize URL carried no `scope` at all. BIMcollab's IdentityServer answers a scope-less authorize request with `invalid_request`, so sign-in could not start even with a valid client id. The preset now sends `openid offline_access bcf`, the value the BIMcollab Connection API implementation guide documents for both the playground and issued credentials.
