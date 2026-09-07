# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Corrected reproduction helper; not part of the historical measured harness."""
import signal

def begin_training_shutdown(connection, session, process):
    errors = []
    try:
        for name, resource in (("upload connection", connection), ("session", session)):
            if resource is None:
                continue
            try:
                resource.close()
            except Exception as error:
                errors.append(f"{name} close failed: {error}")
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
    return errors

def training_transport_success(result):
    return (result.get("exitCode") == 0
            and bool(result.get("loadSuccess") and result.get("cacheReplaySuccess"))
            and not result.get("shutdownTimedOut", False)
            and not result.get("deadlineKilled", False)
            and "error" not in result)
