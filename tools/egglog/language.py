"""Validate typed optimizer jobs and lower their shared signature to egglog."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import re

from demand import DemandLanguage, demand_language


SORTS = {name: f"MW_{name}" for name in ("scalar", "color", "surface")}
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]{0,63}$")
MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_TERMS = 1024


@dataclass(frozen=True)
class PreparedJob:
    program: str
    root: str
    names: dict[str, str]
    costs: dict[str, int]
    demand: DemandLanguage | None
    depth: int


def require(condition, message):
    if not condition:
        raise ValueError(message)


def identifier(value, label):
    require(isinstance(value, str) and IDENTIFIER.fullmatch(value), f"Invalid {label}.")
    return value


def integer(value, label, minimum, maximum):
    require(type(value) is int and minimum <= value <= maximum,
            f"{label} must be an integer in [{minimum}, {maximum}].")
    return value


def encoded(value):
    # Egglog accepts literal Unicode, but not JSON's optional \\uXXXX escapes.
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return sha256(encoded(value).encode("utf-8")).hexdigest()


def prepare(job):
    """Check sorts and graph structure, then generate a closed egglog program."""
    require(isinstance(job, dict) and type(job.get("version")) is int and job["version"] == 1,
            "Expected a version 1 optimizer job.")
    require(isinstance(job.get("ruleset"), str) and 0 < len(job["ruleset"]) <= 128,
            "Expected a named ruleset.")
    operators, rules, terms = (job.get(key) for key in ("operators", "rules", "terms"))
    require(isinstance(operators, dict) and 0 < len(operators) <= 32, "Expected 1–32 operators.")
    require(isinstance(rules, list) and len(rules) <= 128, "Expected at most 128 equations.")
    require(isinstance(terms, list) and 0 < len(terms) <= MAX_TERMS,
            f"Expected 1–{MAX_TERMS} terms.")
    names = {}
    for index, (name, operator) in enumerate(sorted(operators.items())):
        identifier(name, "operator name")
        require(isinstance(operator, dict) and operator.get("result") in SORTS,
                f"Invalid result sort for {name}.")
        inputs = operator.get("inputs")
        require(isinstance(inputs, list) and len(inputs) <= 8 and all(s in SORTS for s in inputs),
                f"Invalid input sorts for {name}.")
        require(type(operator.get("atom", False)) is bool, f"Invalid atom flag for {name}.")
        require(not operator.get("atom") or not inputs, f"Atom {name} cannot have term inputs.")
        require(type(operator.get("componentwise", False)) is bool,
                f"Invalid componentwise flag for {name}.")
        if "channel" in operator:
            identifier(operator["channel"], f"component for {name}")
        names[name] = f"MWOp{index}"

    lines = [f"(sort {name})" for name in SORTS.values()]
    for name, engine_name in names.items():
        operator = operators[name]
        inputs = ["String"] if operator.get("atom") else [SORTS[s] for s in operator["inputs"]]
        lines.append(f"(constructor {engine_name} ({' '.join(inputs)}) {SORTS[operator['result']]})")
    lines.append("(ruleset mw_exact)")

    def pattern(node, variables, variable_names, depth=0):
        require(depth <= 32, "Equation exceeds the pattern depth limit.")
        if isinstance(node, str):
            require(node in variables, f"Undeclared equation variable {node}.")
            return variables[node], variable_names[node], {node}
        require(isinstance(node, dict) and node.get("op") in operators, "Unknown equation constructor.")
        operator, args = operators[node["op"]], node.get("args")
        require(not operator.get("atom"), "Equations cannot invent or inspect source identities.")
        require(isinstance(args, list) and len(args) == len(operator["inputs"]),
                f"Wrong equation arity for {node['op']}.")
        children = [pattern(child, variables, variable_names, depth + 1) for child in args]
        require([child[0] for child in children] == operator["inputs"],
                f"Equation input sort mismatch at {node['op']}.")
        expr = f"({names[node['op']]}{' ' if children else ''}{' '.join(child[1] for child in children)})"
        return operator["result"], expr, set().union(*(child[2] for child in children))

    rule_ids = set()
    for rule in rules:
        require(isinstance(rule, dict) and isinstance(rule.get("id"), str)
                and 0 < len(rule["id"]) <= 128, "Expected a named equation.")
        require(rule["id"] not in rule_ids, f"Duplicate equation ID {rule['id']}.")
        rule_ids.add(rule["id"])
        variables = rule.get("variables")
        require(isinstance(variables, dict) and len(variables) <= 32
                and all(s in SORTS for s in variables.values()), "Invalid equation variable sorts.")
        variable_names = {identifier(name, "variable"): f"v{index}"
                          for index, name in enumerate(sorted(variables))}
        require(isinstance(rule.get("left"), dict), "Equation left side must be a constructor.")
        left = pattern(rule["left"], variables, variable_names)
        right = pattern(rule.get("right"), variables, variable_names)
        require(left[0] == right[0], f"Equation {rule['id']} changes the result sort.")
        require(right[2] <= left[2], f"Equation {rule['id']} has an unbound right-side variable.")
        require(left[2] == set(variables), f"Equation {rule['id']} declares an unused variable.")
        lines.append(f"(rewrite {left[1]} {right[1]} :ruleset mw_exact :name {encoded(rule['id'])})")

    by_id, source_sorts = {}, {}
    for term in terms:
        require(isinstance(term, dict), "Expected a term object.")
        term_id = identifier(term.get("id"), "term ID")
        require(term_id not in by_id, f"Duplicate term ID {term_id}.")
        require(term.get("op") in operators, f"Unknown operator at {term_id}.")
        operator = operators[term["op"]]
        if operator.get("atom"):
            source = identifier(term.get("source"), "source identity")
            require("args" not in term, f"Atom {term_id} cannot have term inputs.")
            require(source_sorts.get(source, operator["result"]) == operator["result"],
                    f"Source {source} appears with different sorts.")
            source_sorts[source] = operator["result"]
        else:
            require("source" not in term, f"Constructor {term_id} cannot have a source identity.")
            require(isinstance(term.get("args"), list) and len(term["args"]) == len(operator["inputs"]),
                    f"Wrong term arity at {term_id}.")
            for arg in term["args"]:
                identifier(arg, "term reference")
        by_id[term_id] = term
    require(job.get("output") in by_id, "Unknown output term.")

    costs = job.get("termCostBySource", {})
    require(isinstance(costs, dict), "termCostBySource must be an object.")
    for source, cost in costs.items():
        require(source in source_sorts, f"Cost refers to unknown source {source}.")
        integer(cost, f"Cost for {source}", 1, 1_000_000_000)

    ordered, state, depths = [], {}, {}

    def visit(start):
        stack = [(start, False)]
        while stack:
            term_id, expanded = stack.pop()
            term, operator = by_id[term_id], operators[by_id[term_id]["op"]]
            if expanded:
                depth = 1 + max((depths[arg] for arg in term.get("args", [])), default=0)
                require(depth <= 512, "Term graph exceeds the depth limit.")
                depths[term_id], state[term_id] = depth, 2
                ordered.append(term)
                continue
            require(state.get(term_id) != 1, f"Cyclic term graph at {term_id}.")
            if state.get(term_id) == 2:
                continue
            state[term_id] = 1
            stack.append((term_id, True))
            for index in reversed(range(len(term.get("args", [])))):
                arg = term["args"][index]
                require(arg in by_id, f"Dangling reference {arg} at {term_id}.")
                require(operators[by_id[arg]["op"]]["result"] == operator["inputs"][index],
                        f"Term input sort mismatch at {term_id}.")
                stack.append((arg, False))

    # Validate even disconnected terms, but only send the live root to egglog.
    for term_id in by_id:
        visit(term_id)
    live, pending = set(), [job["output"]]
    while pending:
        term_id = pending.pop()
        if term_id not in live:
            live.add(term_id)
            pending.extend(by_id[term_id].get("args", []))
    ordered = [term for term in ordered if term["id"] in live]
    demand = demand_language(operators, names, ordered)
    if demand:
        lines.extend(demand.declarations)
    bindings = {term["id"]: f"$t{index}" for index, term in enumerate(ordered)}
    for term in ordered:
        operator = operators[term["op"]]
        args = [encoded(term["source"])] if operator.get("atom") else [bindings[arg] for arg in term["args"]]
        name = demand.source_names.get(term["op"], names[term["op"]]) if demand else names[term["op"]]
        lines.append(f"(let {bindings[term['id']]} ({name}{' ' if args else ''}{' '.join(args)}))")
    root = bindings[job["output"]]
    return PreparedJob("\n".join(lines) + "\n", root, names, costs, demand, depths[job["output"]])


