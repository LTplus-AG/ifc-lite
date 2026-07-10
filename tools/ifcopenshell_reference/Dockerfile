# Hermetic environment for the nightly reference run: the pinned engine is
# the source of truth for "which reference version we are parity-checked
# against"; bumping it is an explicit, reviewed change.
FROM python:3.12-slim
WORKDIR /harness
COPY requirements.lock .
RUN pip install --no-cache-dir -r requirements.lock
COPY canonical.py dump_reference.py compare.py allowlist.json ./
ENTRYPOINT ["python"]
