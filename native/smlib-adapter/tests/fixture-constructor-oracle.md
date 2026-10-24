<!-- SPDX-License-Identifier: MPL-2.0 -->
# Fixture constructor mutation disposition (#7955, D96)

Original R14 mutation 58 (`FixtureVertex() {}` to `FixtureVertex()=default;`,
selector `refusals`) survived. The aggregate at source
`95219270c4472b45334a0727455ccb7058a34cba` remains **failed**: 57/58 lineage
mutations observed, with the last mutant exiting 0. This is not a kill, a
waiver of production behavior, or evidence of a selector omission.

## Cause and scope

The recorded native build uses GCC 13.3.0, `-O2 -g -DNDEBUG
-fno-omit-frame-pointer -fno-optimize-sibling-calls`. The SDK revision is
`c9c5979f04cea8c38213004d4f04df0dcfb40d05` (prepared `imprint-status-v1`).
Its allocation path is `SmTopology::operator new` (`SmTopology.cpp:571`),
then `SmObject::operator new` (`SmObject.cpp:338`). The allocator writes
`m_cpContext` and records the address in thread-local storage. `SmObject`'s
constructor (`SmObject.cpp:79`) preserves that value when the address is
registered; it does not restore an erased value.

[C++ value-initialization](https://eel.is/c++draft/dcl.init.general#8) first
zero-initializes a class whose selected default constructor is not
user-provided. Keep both user-provided fixture constructors to avoid requesting
that zero-initialization over allocator-written SDK state.

However, the pinned `SmVertex` constructor is inline (`SmVertex.h:117`),
whereas `SmFace`'s constructor is out of line (`SmFace.cpp:69`). On the recorded
compiler, inlining exposes constructor lifetime clobbers and lifetime dead
store elimination removes the vertex mutant's zero-fill. The face zero-fill
survives before the opaque constructor call. GCC's `dse2` dump explicitly
reports `Deleted dead store: MEM[(struct DefaultVertex *)_4] = {};` and shows
the inlined constructor lifetime clobbers. The SDK's reliance on storage
written before construction is precisely the kind of lifetime assumption
covered by [GCC's `-flifetime-dse` documentation](https://gcc.gnu.org/onlinedocs/gcc-13.3.0/gcc/Optimize-Options.html#index-flifetime-dse).

Small allocation functions compiled against the actual SDK headers show no
store between the allocator and `SmObject` constructor for either vertex at
`-O2`. The defaulted face instead has `rep stosq` for 25 eight-byte words.
Changing only the diagnostic compilation to `-flifetime-dse=1` restores
`rep stosq` for 24 words in the defaulted vertex. The control remains unchanged.
Fresh-process context probes linked to the retained, unmodified SDK archives
observed:

| Fixture constructor | `-O2` | `-O2 -flifetime-dse=1` | `-O0` |
| --- | --- | --- | --- |
| User-provided face | Context preserved | Context preserved | Context preserved |
| Defaulted face | Context null, exit 1 | Context null, exit 1 | Context null, exit 1 |
| User-provided vertex | Context preserved | Context preserved | Context preserved |
| Defaulted vertex | Context preserved | Context null, exit 1 | Context null, exit 1 |

Each probe checks context before setters or destruction; none writes a context
or synthesizes a notification. These results establish equivalence **for the
context-loss oracle on this build**, not language-level equivalence, portability
of the SDK allocation convention, or safety of defaulting the vertex fixture.
No production or test build flags are changed to force a kill.

## Replacement and inventory

Only slot 58 changes. It now removes `SmVertex_TYPE` from the production leaf
classification through the mutation runner. The ordinary production source
is unchanged. The existing `refusals` witness allocates a real unattached
vertex with the real SDK allocator and requires its construction callback to
carry a nonzero generation. Without classification the callback still arrives,
but its generation is missing. A small actual-SDK lifecycle probe observed:

- Control: matching context, one construction event, generation 1; matching
  destruction receipt; exit 0.
- Replacement mutant: matching context, one construction event, generation 0;
  exit 1 with `actual fixture vertex delivers its construction generation`.

The original context comparison, constructor/destructor assertions, face
allocation/reuse witness, and positive vertex/nested-setter witnesses stay.
The runner prints the withdrawal explicitly; it does not count the survivor as
observed. Active inventory is 61: original 1–57 unchanged, one replacement in
slot 58, and all three D96 boundary mutants unchanged. All seven source mutants
are unchanged. Original mutation 58 is the sole withdrawn expectation.

## Reproduce without a full build

Compile these allocation functions with the recorded defines
`SM_NO_DEBUG_CODE`, `SM_NO_GFX_OUTPUT_CODE`, `NDEBUG`, C++17, and both prepared
SDK include directories. Use `-S` with `-O2`, then `-O2 -flifetime-dse=1` or
`-O0`; inspect the allocator-to-base-constructor span. This is compiler
diagnosis, not a test that asserts on source text or instruction spelling.

```cpp
#include <SmFace.h>
#include <SmVertex.h>
class UserFace final: public SmFace { public: UserFace() {} };
class DefaultFace final: public SmFace { public: DefaultFace()=default; };
class UserVertex final: public SmVertex { public: UserVertex() {} };
class DefaultVertex final: public SmVertex { public: DefaultVertex()=default; };
SmObject* user_face(SmObject* owner) { return new(owner) UserFace(); }
SmObject* default_face(SmObject* owner) { return new(owner) DefaultFace(); }
SmObject* user_vertex(SmObject* owner) { return new(owner) UserVertex(); }
SmObject* default_vertex(SmObject* owner) { return new(owner) DefaultVertex(); }
```

The handoff retains these sources, assembly, runtime probes and results. The
small replacement probe links one mutated adapter translation unit before the
retained adapter/SDK archives; it does not rebuild the SDK or replace callbacks.
**UNRUN on the corrected source:** full native controls, the complete 61-case
lineage runner, seven-case source runner, boundary qualification, WASM and
cross-compiler checks. The parent owns admission and independent qualification.
