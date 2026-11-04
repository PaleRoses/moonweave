"""Paired fresh-engine measurements; Python startup is outside the measured work."""

from __future__ import annotations

import argparse
from importlib.util import module_from_spec, spec_from_file_location
import json
from pathlib import Path
from statistics import median
import sys
from time import perf_counter_ns

from run import run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    args = parser.parse_args()
    specification = spec_from_file_location("moonweave_baseline_egglog", args.baseline / "tools/egglog/run.py")
    baseline = module_from_spec(specification)
    sys.modules[specification.name] = baseline
    specification.loader.exec_module(baseline)
    jobs = json.load(sys.stdin)
    results = []
    for case in jobs:
        functions = {"baseline": baseline.run, "current": run}
        # Warm the Python/native binding boundary, retaining no engine between runs.
        candidates = {name: function(case[name], iterations=100, rows=50_000)
                      for name, function in functions.items()}
        elapsed = {name: [] for name in functions}
        for batch in range(7):
            for name in (list(functions) if batch % 2 == 0 else list(reversed(functions))):
                started = perf_counter_ns()
                candidate = functions[name](case[name], iterations=100, rows=50_000)
                elapsed[name].append((perf_counter_ns() - started) / 1_000_000)
                if candidate != candidates[name]:
                    raise AssertionError(f"Non-deterministic native result for {case['name']} / {name}")
        results.append({"name": case["name"], "candidates": candidates,
                        "milliseconds": {name: {"median": median(values), "batches": values}
                                         for name, values in elapsed.items()}})
    json.dump(results, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
