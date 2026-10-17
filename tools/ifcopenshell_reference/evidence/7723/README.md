# Invalid nonempty Boolean reference (#7723)

The `.log.gz` files decompress to unmodified native stdout streams from pinned IfcOpenShell 0.8.5,
OpenCascade, on the catalogue SOffice IFC. The product #396617 returned the
same oriented 20-vertex/36-triangle mesh as its uncut base #392821, despite
six invalid-result retries and a terminal Boolean failure. The base stream
is the positive diagnostic control. Do not interpret a transient invalid
retry, a valid disjoint operation, or an empty `get_log()` as that failure.

Source fixture SHA256:
`38c4ecbbc67d0759dfcffb2c90664f5b5231e6c48fc54597c62975b41bb629db`

Original serial four-item capture receipt SHA256:
`0534be9f51ad61aee2dbbdc31fd9a2ba1e7fb7f7d879aa675736e04b4b105707`.
The worker enabled detailed JSON logging, which redirects the native logger
to stdout; both the before/after `get_log()` buffers were empty. Exact
independent finite geometry certificates found a positive interior ball in
both operands and proved the old filled surface disk strictly inside the
second operand. This establishes an invalid reference, not a global native
geometry pass. See the linked issue for the complete evidence paths.

The admission test hashes these real streams and checks the failure class.
No test generates an expected engine failure by mocking `create_shape`.
