---
"@ifc-lite/collab-server": minor
---

Add room tokens for accountless, link-based access control. `signRoomToken` /
`verifyRoomToken` implement HS256 (on `node:crypto`, no JWT dependency) carrying
the room id + granted role, with `kid` key-rotation and `jti` revocation support.
`createRoomTokenAuthenticator` plugs into `startCollabServer({ authenticate })`,
and the optional `tokenEndpoint` enables a `POST /collab/token` mint route (with
a pluggable `authorize` policy and CORS) for the viewer's Share dialog.
