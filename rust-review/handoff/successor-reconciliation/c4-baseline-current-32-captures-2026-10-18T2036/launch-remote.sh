set -e
source /home/louistrue/build-workers/worker-env.sh
mkdir /home/louistrue/build-workers/worker-state/c4-0-baseline61-counterparts-preexec-v2
export TMPDIR=/home/louistrue/build-workers/worker-state/c4-0-baseline61-counterparts-preexec-v2
export NODE_COMPILE_CACHE=/home/louistrue/build-workers/worker-state/c4-0-baseline61-counterparts-preexec-v2/node-cache
export CARGO_NET_OFFLINE=true
export PYTHONDONTWRITEBYTECODE=1
export CARGO_TARGET_DIR=/home/louistrue/build-workers/worker-state/targets/c4-0-baseline61-counterparts-v2
exec nice -n 10 python3 /home/louistrue/build-workers/worker-current/worker.py --state /home/louistrue/build-workers/worker-state run --cwd /home/louistrue/build-workers/worker-state/checkouts/61f9cb64803b37270fcc0603d97f5f47808212bf --kind ordinary --cpu 2 --memory 8 --queue-timeout 1 --timeout 5400 --require-clean --commit 61f9cb64803b37270fcc0603d97f5f47808212bf --resource /home/louistrue/build-workers/worker-state/c4-0-baseline61-counterparts-inputs-v2 --resource /home/louistrue/build-workers/worker-state/c4-0-baseline61-counterparts-preexec-v2 --resource /home/louistrue/build-workers/worker-state/targets/c4-0-baseline61-counterparts-v2 --resource /home/louistrue/build-workers/worker-state/targets/c4-0-baseline61-counterparts-v2/native-plain --resource /home/louistrue/build-workers/worker-state/checkouts/c4-0-baseline61-native-capture-v2 --resource /home/louistrue/build-workers/worker-state/c4-0-baseline61-regular-fixtures-v2 --artifact /home/louistrue/build-workers/worker-state/targets/c4-0-baseline61-counterparts-v2/results/report.json -- python3 /home/louistrue/build-workers/worker-state/c4-0-baseline61-counterparts-inputs-v2/run-baseline.py
