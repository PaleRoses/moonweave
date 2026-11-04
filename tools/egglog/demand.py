"""Compile finite finish-component demand from the exported effect signature.

Source surfaces have their own sort. Projection rules can create result terms,
but never source terms, so they cannot turn their output into another analysis
input. With C finish components and S source surfaces there are at most S * 2**C
projection contexts. Current Moonweave has four finish components.
"""

from __future__ import annotations

from dataclasses import dataclass


SOURCE_SORT = "MW_SourceSurface"
PROJECT = "MW_Project"
PROJECTED_ROOT = "$mw_projected"
RULESET = "mw_demand"
MAX_COMPONENTS = 4


@dataclass(frozen=True)
class DemandLanguage:
    declarations: tuple[str, ...]
    source_names: dict[str, str]
    full_mask: int
    components: tuple[str, ...]
    source_terms: int

    @property
    def context_limit(self):
        return self.source_terms * (1 << len(self.components))

    def root(self, source):
        return f"(let {PROJECTED_ROOT} ({PROJECT} {source} {self.full_mask}))"


def demand_language(operators, names, terms):
    """Return a projection language only when the manifest opts in and needs it.

Channel writers carry their selected component in the shared signature.
Other participating surface operations must explicitly promise componentwise
behavior. Legacy manifests keep their original equation-only execution path.
"""
    components = tuple(sorted({operator["channel"] for operator in operators.values()
                               if isinstance(operator.get("channel"), str)}))
    if not 0 < len(components) <= MAX_COMPONENTS:
        return None
    bits = {component: 1 << index for index, component in enumerate(components)}
    full_mask = (1 << len(components)) - 1
    surface_operators = {name: operators[name] for name in names
                         if operators[name]["result"] == "surface"}
    for operator in operators.values():
        inputs = operator["inputs"]
        if operator["result"] != "surface":
            if "surface" in inputs:
                return None
        elif operator.get("atom"):
            continue
        elif "channel" in operator:
            if operator["channel"] not in bits or inputs != ["surface", "scalar"]:
                return None
        elif operator.get("componentwise") is not True or "surface" not in inputs:
            return None

    # This inexpensive may-write analysis avoids a native projection phase when
    # no write can be shadowed. It changes no term and claims no equivalence.
    writes, shadowed, source_terms = {}, False, 0
    for term in terms:
        operator = operators[term["op"]]
        if operator["result"] != "surface":
            continue
        source_terms += 1
        inherited = 0
        for arg, sort in zip(term.get("args", []), operator["inputs"]):
            if sort == "surface":
                inherited |= writes[arg]
        selected = bits.get(operator.get("channel"), 0)
        shadowed |= bool(selected & inherited)
        writes[term["id"]] = inherited | selected
    if not shadowed:
        return None

    source_names = {name: f"MW_Source_{names[name]}" for name in surface_operators}
    lines = [f"(sort {SOURCE_SORT})",
             f"(constructor {PROJECT} ({SOURCE_SORT} i64) MW_surface :unextractable)",
             f"(ruleset {RULESET})"]

    def rewrite(left, right, name, condition=""):
        when = f" :when ({condition})" if condition else ""
        lines.append(f'(rewrite {left} {right}{when} :ruleset {RULESET} :name "{name}")')

    for name, source_name in source_names.items():
        operator = operators[name]
        inputs = (["String"] if operator.get("atom") else
                  [SOURCE_SORT if sort == "surface" else f"MW_{sort}"
                   for sort in operator["inputs"]])
        args = [f"a{index}" for index in range(len(inputs))]
        lines.append(f"(constructor {source_name} ({' '.join(inputs)}) {SOURCE_SORT})")
        source = f"({source_name} {' '.join(args)})"
        left = f"({PROJECT} {source} demand)"
        if operator.get("atom"):
            rewrite(left, f"({names[name]} {args[0]})", f"demand-{name}")
        elif "channel" in operator:
            bit = bits[operator["channel"]]
            child = f"({PROJECT} {args[0]} (& demand {full_mask ^ bit}))"
            rewrite(left, f"({names[name]} {child} {args[1]})",
                    f"demand-{name}-keep", f"(= (& demand {bit}) {bit})")
            rewrite(left, f"({PROJECT} {args[0]} demand)",
                    f"demand-{name}-drop", f"(= (& demand {bit}) 0)")
        else:
            projected = [f"({PROJECT} {arg} demand)" if sort == "surface" else arg
                         for arg, sort in zip(args, operator["inputs"])]
            rewrite(left, f"({names[name]} {' '.join(projected)})", f"demand-{name}")
    return DemandLanguage(tuple(lines), source_names, full_mask, components, source_terms)
