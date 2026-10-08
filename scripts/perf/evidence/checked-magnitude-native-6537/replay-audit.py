# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Replay the retained data-only audit in an extracted copy; no models/builds."""
import argparse, pathlib
p = argparse.ArgumentParser()
p.add_argument('--extracted', required=True, type=pathlib.Path)
p.add_argument('--repo', required=True, type=pathlib.Path)
a = p.parse_args()
root = (a.extracted.resolve() / 'native-hosted-remote-v4')
assert root != pathlib.Path('/tmp/6232-takeover/6537-native-hosted-remote-v4')
source = (root / 'audit-v2.py').read_text()
old = "root=pathlib.Path('/tmp/6232-takeover/6537-native-hosted-remote-v4'); artifact=root/'artifacts/native-phase-37149940166-1'; wt=pathlib.Path('/home/louistrue/wt/6537-native-phase-hosted-session6503')"
assert source.count(old) == 1
new = 'root=pathlib.Path(' + repr(str(root)) + "); artifact=root/'artifacts/native-phase-37149940166-1'; wt=pathlib.Path(" + repr(str(a.repo.resolve())) + ')'
# Only extraction/Git-object locations change. All predicates and raw data remain exact.
exec(compile(source.replace(old, new), str(root / 'audit-v2.py'), 'exec'), {'__name__': '__main__'})
