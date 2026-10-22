# SPDX-License-Identifier: MPL-2.0
"""Frozen descriptive paired-block estimates; bootstrap intervals are not equivalence tests."""
import hashlib
import math
import random
import statistics

BOOTSTRAP_DRAWS = 10000
SEED_DOMAIN = 'bf7d2a91-publication-layer-perf-v1'

def percentile(values, probability):
    ordered = sorted(values)
    rank = (len(ordered) - 1) * probability
    lower = math.floor(rank)
    upper = math.ceil(rank)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (rank - lower)

def compare_blocks(blocks, contrasts, label):
    """blocks contain one value per arm; resample the complete matched block."""
    assert len(blocks) >= 2
    assert all(all(math.isfinite(v) and v > 0 for v in block.values()) for block in blocks)
    rng = random.Random(int(hashlib.sha256((SEED_DOMAIN + '|' + label).encode()).hexdigest(), 16))
    ratios = {name: [100 * (block[numerator] / block[denominator] - 1) for block in blocks]
              for name, (numerator, denominator) in contrasts.items()}
    distributions = {name: [] for name in contrasts}
    for _ in range(BOOTSTRAP_DRAWS):
        indices = [rng.randrange(len(blocks)) for _ in blocks]
        for name in contrasts:
            distributions[name].append(statistics.median(ratios[name][i] for i in indices))
    result = {}
    for name, (numerator, denominator) in contrasts.items():
        samples = ratios[name]
        result[name] = {
            'numerator': numerator, 'denominator': denominator,
            'pairedBlockDeltasPct': samples,
            'pairedMedianDeltaPct': statistics.median(samples),
            'pairedMedianPercentile95CI': [percentile(distributions[name], 0.025), percentile(distributions[name], 0.975)],
            'ratioOfArmMediansDeltaPct': 100 * (statistics.median(b[numerator] for b in blocks) / statistics.median(b[denominator] for b in blocks) - 1),
            'slowerBlocks': sum(value > 0 for value in samples),
            'blocks': len(blocks),
            'bootstrapDraws': BOOTSTRAP_DRAWS,
            'intervalScope': 'Marginal descriptive 95% percentile interval, not multiplicity-adjusted, not an equivalence or acceptance margin; six-block native intervals have limited precision.',
        }
    return result
