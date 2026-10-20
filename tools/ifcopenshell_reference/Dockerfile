# Container environment for the reference run: the resolved engine is
# the source of truth for "which reference version we are parity-checked
# against"; the actual version is recorded in every output.
FROM python:3.12-slim
WORKDIR /harness
COPY requirements.lock .
RUN pip install --no-cache-dir -r requirements.lock
COPY canonical.py dump_reference.py reference_validation.py reference_worker.py compare.py allowlist.json ./
ENTRYPOINT ["python"]
