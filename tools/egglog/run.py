#!/usr/bin/env python3
"""Run Moonweave's typed effect equations in the real, pinned egglog engine.

The JSON boundary contains constructors and typed equations, never executable
egglog text. Resources and editable values remain identity-bearing atoms.
Iteration and row budgets are checked between native rounds; the caller owns
the hard process timeout. This module has no role in the browser runtime.
"""

from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
from importlib.metadata import PackageNotFoundError, version
import json
from pathlib import Path
import sys

from demand import PROJECT, PROJECTED_ROOT, RULESET as DEMAND_RULESET
from language import MAX_REQUEST_BYTES, MAX_TERMS, digest, encoded, integer, prepare, require


ENGINE_VERSION = "14.0.0"


def run(job, *, iterations=12, rows=50_000, extractor="greedy-dag"):
    integer(iterations, "iterations", 0, 128)
    integer(rows, "rows", 1, 2_000_000)
    require(extractor in ("tree", "greedy-dag"), "Unknown extractor.")
    prepared = prepare(job)
    demand = prepared.demand
    program = prepared.program + (demand.root(prepared.root) + "\n" if demand else "")
    try:
        actual_version = version("egglog")
    except PackageNotFoundError as error:
        raise RuntimeError("Install tools/egglog/requirements.txt with Python 3.12 or newer.") from error
    require(actual_version == ENGINE_VERSION, f"Expected egglog=={ENGINE_VERSION}; found {actual_version}.")
    from egglog import bindings as egg

    egraph = egg.EGraph(num_threads=1)
    egraph.parse_and_run_program(program, filename="moonweave-effects.egg")
    by_engine_name = {engine_name: name for name, engine_name in prepared.names.items()}
    if demand:
        by_engine_name.update({engine_name: name for name, engine_name in demand.source_names.items()})

    def row_sizes():
        return dict(egraph.parse_and_run_program("(print-size)")[0].sizes)

    def marginal_cost(name, args):
        operator = job["operators"][by_engine_name[name]]
        return prepared.costs.get(egraph.value_to_string(args[0]), 1) if operator.get("atom") else 1

    cost_model = egg.DagCostModel(0, marginal_cost, lambda _sort, _value: 0, lambda _sort, _value: 0)
    root_expr = egg.Var(egg.PanicSpan(), prepared.root)
    root = egraph.eval_expr(root_expr)
    _, initial = egg.extract_best_with_dag_cost_model(egraph, [root], cost_model, extractor=extractor)
    initial_cost = initial[0][0]
    sizes = row_sizes()

    def phase(ruleset, limit):
        nonlocal sizes
        rounds, matches, stop = 0, Counter(), "iteration-limit"
        while rounds < limit:
            if sum(sizes.values()) >= rows:
                stop = "row-limit"
                break
            report = egraph.parse_and_run_program(f"(run-schedule (run {ruleset}))")[0].report
            rounds += 1
            matches.update({name: count for name, count in report.num_matches_per_rule.items() if count})
            sizes = row_sizes()
            if report.can_stop and not report.updated:
                stop = "saturated"
                break
            if sum(sizes.values()) >= rows:
                stop = "row-limit"
                break
        return {"rounds": rounds, "rows": sum(sizes.values()), "stopReason": stop,
                "matches": dict(sorted(matches.items())), "roundLimit": limit}

    # Projection is finite dataflow, bounded by source depth rather than a
    # heuristic search budget. An interrupted phase extracts the original root;
    # an uncompleted projection is never presented as an optimized surface.
    projection = None
    search = {"rounds": 0, "rows": sum(sizes.values()), "stopReason": "not-run",
              "matches": {}, "roundLimit": iterations}
    if demand:
        projection = phase(DEMAND_RULESET, prepared.depth + 1 if iterations else 0)
        projection.update({"components": demand.components, "sourceTerms": demand.source_terms,
                           "contexts": sizes.get(PROJECT, 0), "contextLimit": demand.context_limit})
        require(projection["contexts"] <= demand.context_limit, "Demand context bound was exceeded.")
        if projection["stopReason"] == "saturated":
            root = egraph.eval_expr(egg.Var(egg.PanicSpan(), PROJECTED_ROOT))
            search = phase("mw_exact", iterations)
            stop = search["stopReason"]
        else:
            stop = ("row-limit" if projection["stopReason"] == "row-limit" else
                    "iteration-limit" if not iterations else "projection-limit")
    else:
        search = phase("mw_exact", iterations)
        stop = search["stopReason"]
    matches = Counter(search["matches"])
    if projection:
        matches.update(projection["matches"])
    rounds = search["rounds"] + (projection["rounds"] if projection else 0)

    dag, extracted = egg.extract_best_with_dag_cost_model(egraph, [root], cost_model, extractor=extractor)
    require(extracted[0] is not None, "The root has no finite extraction.")
    cost, extracted_root = extracted[0]
    decoded, decoded_ids, depths = [], {}, {}
    known_atoms = {(term["op"], term["source"]) for term in job["terms"] if "source" in term}
    pending = [(extracted_root, False)]
    while pending:
        term_id, expanded = pending.pop()
        if term_id in decoded_ids:
            continue
        term = dag.get(term_id)
        require(isinstance(term, egg.TermApp) and term.name in by_engine_name,
                "Unexpected constructor in extraction.")
        op = by_engine_name[term.name]
        operator = job["operators"][op]
        if operator.get("atom"):
            literal = dag.get(term.args[0])
            require(isinstance(literal, egg.TermLit) and isinstance(literal.value, egg.String),
                    "Extracted atom has no string identity.")
            source = literal.value.value
            require((op, source) in known_atoms, "Extraction invented a source identity.")
            body = {"op": op, "source": source}
            depth = 1
        else:
            if not expanded:
                pending.append((term_id, True))
                pending.extend((arg, False) for arg in reversed(term.args))
                continue
            body = {"op": op, "args": [decoded_ids[arg] for arg in term.args]}
            depth = 1 + max((depths[arg] for arg in term.args), default=0)
        require(depth <= 512, "Extracted term graph exceeds the depth limit.")
        require(len(decoded) < MAX_TERMS, "Extracted graph exceeds the term limit.")
        node_id = f"e{len(decoded)}"
        decoded_ids[term_id], depths[term_id] = node_id, depth
        decoded.append({"id": node_id, **body})
    output = decoded_ids[extracted_root]
    manifest = {key: job[key] for key in ("ruleset", "operators", "rules")}
    return {
        "version": 1, "ruleset": job["ruleset"], "terms": decoded, "output": output,
        "receipt": {
            "engine": "egglog", "version": actual_version, "extractor": extractor,
            "rounds": rounds, "rows": sum(sizes.values()), "stopReason": stop,
            "initialCost": initial_cost, "cost": cost, "matches": dict(sorted(matches.items())),
            "limits": {"iterations": iterations, "rows": rows}, "threads": 1,
            "projection": projection, "search": search,
            "jobSha256": digest(job), "rulesSha256": digest(manifest),
            "programSha256": sha256(program.encode("utf-8")).hexdigest(),
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", default="-", help="Job JSON path, or - for stdin.")
    parser.add_argument("--output", default="-", help="Result JSON path, or - for stdout.")
    parser.add_argument("--iterations", type=int, default=12)
    parser.add_argument("--rows", type=int, default=50_000)
    parser.add_argument("--extractor", choices=("tree", "greedy-dag"), default="greedy-dag")
    args = parser.parse_args()
    try:
        if args.input == "-":
            data = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        else:
            with Path(args.input).open("rb") as source:
                data = source.read(MAX_REQUEST_BYTES + 1)
        require(len(data) <= MAX_REQUEST_BYTES, "Optimizer job exceeds the input size limit.")
        result = run(json.loads(data), iterations=args.iterations, rows=args.rows, extractor=args.extractor)
        text = encoded(result) + "\n"
        if args.output == "-":
            sys.stdout.write(text)
        else:
            Path(args.output).write_text(text, encoding="utf-8")
    except Exception as error:
        print(f"Moonweave egglog: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
