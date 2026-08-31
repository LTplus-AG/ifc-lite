---
'@ifc-lite/provenance': minor
---

A commutation certificate minted with a weakened `epsilonMm` can now be caught at verification time: `verifyCommutationCertificate` accepts a new `expectedEpsilonMm` option and fails with `epsilon-mismatch` when the certificate's own epsilon doesn't match it, the same protection `expectedTrustRoot`/`expectedClientA`/`expectedClientB` already give the other unbindable fields.
