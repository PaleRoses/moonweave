"""Optional native-engine checks: python tools/egglog/test_run.py."""

from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import unittest

from language import prepare
from run import run


ROOT = Path(__file__).resolve().parents[2]
DRIVER = Path(__file__).with_name("run.py")


class NativeEgglogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            ["node", "--input-type=module", "-e", """
                import {EFFECT_OPERATORS,EXACT_EFFECT_RULES} from './src/core/effects.mts';
                console.log(JSON.stringify({operators:EFFECT_OPERATORS,rules:EXACT_EFFECT_RULES}));
            """], cwd=ROOT, capture_output=True, text=True, check=True,
        )
        cls.manifest = json.loads(result.stdout)

    def job(self):
        return {
            "version": 1, "ruleset": "surface-effects/1", **deepcopy(self.manifest),
            "terms": [
                {"id": "base", "op": "SurfaceAtom", "source": "body"},
                {"id": "old", "op": "ScalarAtom", "source": "old_mask"},
                {"id": "ink", "op": "ColorAtom", "source": "pigment"},
                {"id": "coverage", "op": "ScalarAtom", "source": "coverage"},
                {"id": "next", "op": "ScalarAtom", "source": "new_mask"},
                {"id": "inner", "op": "Roughness", "args": ["base", "old"]},
                {"id": "coated", "op": "Coat", "args": ["inner", "ink", "coverage"]},
                {"id": "output", "op": "Roughness", "args": ["coated", "next"]},
            ],
            "output": "output",
        }

    def assert_observations(self, job, result):
        # The independent TypeScript product interpreter owns this check. It
        # does not import the generated native projection language or schedule.
        check = subprocess.run(
            ["node", "--input-type=module", "-e", """
                import {readFileSync} from 'node:fs';
                import {projectSurfaceTerms} from './src/core/effects.mts';
                const [job,result]=JSON.parse(readFileSync(0,'utf8')), intern=new Map();
                const before=projectSurfaceTerms(job.terms,job.output,intern);
                const after=projectSurfaceTerms(result.terms,result.output,intern);
                if(JSON.stringify(before)!==JSON.stringify(after))process.exit(1);
            """], cwd=ROOT, input=json.dumps([job, result]), capture_output=True, text=True,
        )
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_real_saturation_removes_shadowed_value_across_coat(self):
        job = self.job()
        result = run(job)
        self.assertEqual(result["receipt"]["stopReason"], "saturated")
        self.assertEqual(result["receipt"]["initialCost"], 8)
        self.assertEqual(result["receipt"]["cost"], 6)
        self.assertEqual(result["receipt"]["projection"]["stopReason"], "saturated")
        self.assertEqual(result["receipt"]["projection"]["matches"]["demand-Roughness-drop"], 1)
        self.assertEqual(result["receipt"]["search"]["matches"], {})
        self.assertEqual({term["source"] for term in result["terms"] if "source" in term},
                         {"body", "pigment", "coverage", "new_mask"})
        self.assert_observations(job, result)

    def test_demand_passes_through_nested_mix_and_preserves_shared_consumers(self):
        job = self.job()
        job["terms"] += [
            {"id": "weight", "op": "ScalarAtom", "source": "branch_weight"},
            {"id": "mixed", "op": "Mix", "args": ["output", "inner", "weight"]},
            {"id": "top", "op": "Roughness", "args": ["mixed", "next"]},
        ]
        job["output"] = "mixed"
        shared = run(job)
        self.assert_observations(job, shared)
        self.assertIn("old_mask", {term.get("source") for term in shared["terms"]})
        projection = shared["receipt"]["projection"]
        self.assertGreater(projection["contexts"], projection["sourceTerms"])
        self.assertLessEqual(projection["contexts"], projection["contextLimit"])
        job["output"] = "top"
        overwritten = run(job)
        self.assert_observations(job, overwritten)
        self.assertNotIn("old_mask", {term.get("source") for term in overwritten["terms"]})
        self.assertIn("branch_weight", {term.get("source") for term in overwritten["terms"]})

    def test_all_sixteen_finish_demands_remain_finite_and_equivalent(self):
        job = self.job()
        writes = [name for name, operator in job["operators"].items() if "channel" in operator]
        terms = [{"id": "base", "op": "SurfaceAtom", "source": "body"},
                 {"id": "weight", "op": "ScalarAtom", "source": "branch_weight"}]

        def emit(op, args):
            name = f"t{len(terms)}"
            terms.append({"id": name, "op": op, "args": args})
            return name

        base = "base"
        for index, op in enumerate(writes):
            terms.append({"id": f"v{index}", "op": "ScalarAtom", "source": f"old_{index}"})
            terms.append({"id": f"n{index}", "op": "ScalarAtom", "source": f"new_{index}"})
            base = emit(op, [base, f"v{index}"])
        branches = []
        for mask in range(16):
            branch = base
            for index, op in enumerate(writes):
                if mask & (1 << index):
                    branch = emit(op, [branch, f"n{index}"])
            branches.append(branch)
        while len(branches) > 1:
            branches = [emit("Mix", [a, b, "weight"]) for a, b in zip(branches[::2], branches[1::2])]
        job.update(terms=terms, output=branches[0])
        result = run(job)
        self.assert_observations(job, result)
        projection = result["receipt"]["projection"]
        self.assertEqual(projection["stopReason"], "saturated")
        self.assertGreater(projection["contexts"], projection["sourceTerms"])
        self.assertLessEqual(projection["contexts"], projection["contextLimit"])
        self.assertEqual(projection["contextLimit"], projection["sourceTerms"] * 16)

    def test_old_manifests_keep_equation_execution_and_jobs_without_shadowing_skip_projection(self):
        job = self.job()
        for operator in job["operators"].values():
            operator.pop("componentwise", None)
        result = run(job)
        self.assertIsNone(result["receipt"]["projection"])
        self.assertEqual(result["receipt"]["cost"], 6)
        self.assert_observations(job, result)
        job = self.job()
        job["output"] = "coated"
        result = run(job)
        self.assertIsNone(result["receipt"]["projection"])
        self.assert_observations(job, result)

    def test_weighted_dag_cost_counts_shared_source_once(self):
        job = self.job()
        job["terms"] = [
            {"id": "base", "op": "SurfaceAtom", "source": "body"},
            {"id": "mask", "op": "ScalarAtom", "source": "mask"},
            {"id": "output", "op": "Mix", "args": ["base", "base", "mask"]},
        ]
        job["termCostBySource"] = {"body": 10, "mask": 2}
        dag, tree = run(job), run(job, extractor="tree")
        self.assertEqual(dag["receipt"]["cost"], 13)
        self.assertEqual(tree["receipt"]["cost"], 23)
        self.assertEqual(len(dag["terms"]), 3)
        self.assertEqual(dag["terms"][-1]["args"][0], dag["terms"][-1]["args"][1])

    def test_budget_stops_are_not_reported_as_saturation(self):
        job = self.job()
        limited = run(job, iterations=0)
        self.assertEqual((limited["receipt"]["stopReason"], limited["receipt"]["rounds"]),
                         ("iteration-limit", 0))
        row_limited = run(job, rows=1)
        self.assertEqual((row_limited["receipt"]["stopReason"], row_limited["receipt"]["rounds"]),
                         ("row-limit", 0))
        self.assertEqual(row_limited["receipt"]["rows"], 9)
        self.assertEqual(row_limited["receipt"]["projection"]["stopReason"], "row-limit")
        self.assertEqual(row_limited["receipt"]["search"]["stopReason"], "not-run")
        self.assertEqual(row_limited["receipt"]["cost"], row_limited["receipt"]["initialCost"])
        interrupted = run(job, rows=12)
        self.assertGreater(interrupted["receipt"]["projection"]["rounds"], 0)
        self.assertEqual(interrupted["receipt"]["stopReason"], "row-limit")
        self.assertEqual(interrupted["receipt"]["search"]["stopReason"], "not-run")
        self.assertEqual(interrupted["receipt"]["cost"], interrupted["receipt"]["initialCost"])
        self.assert_observations(job, interrupted)

    def test_topologically_ordered_and_shared_terms_still_obey_the_actual_depth_limit(self):
        job = self.job()
        terms = [{"id": "base", "op": "SurfaceAtom", "source": "body"},
                 {"id": "height", "op": "ScalarAtom", "source": "height"}]
        previous = "base"
        for index in range(511):
            name = f"b{index}"
            terms.append({"id": name, "op": "Bump", "args": [previous, "height"]})
            previous = name
        job.update(terms=terms, output=previous)
        self.assertEqual(prepare(job).depth, 512)
        terms.append({"id": "too_deep", "op": "Bump", "args": [previous, "height"]})
        job["output"] = "too_deep"
        with self.assertRaisesRegex(ValueError, "depth limit"):
            prepare(job)

    def test_different_editable_identities_remain_distinct(self):
        job = self.job()
        job["terms"] = [
            {"id": "a", "op": "SurfaceAtom", "source": "instance_a"},
            {"id": "b", "op": "SurfaceAtom", "source": "instance_b"},
            {"id": "mask", "op": "ScalarAtom", "source": "mask"},
            {"id": "output", "op": "Mix", "args": ["a", "b", "mask"]},
        ]
        result = run(job)
        self.assertEqual({term["source"] for term in result["terms"] if "source" in term},
                         {"instance_a", "instance_b", "mask"})

    def test_rejects_sort_errors_cycles_and_unbound_rule_variables(self):
        wrong_sort = self.job()
        wrong_sort["terms"][-2]["args"][1] = "old"
        with self.assertRaisesRegex(ValueError, "sort mismatch"):
            prepare(wrong_sort)
        cycle = self.job()
        cycle["terms"][-1]["args"][0] = "output"
        with self.assertRaisesRegex(ValueError, "Cyclic"):
            prepare(cycle)
        invalid_rule = self.job()
        invalid_rule["rules"][0]["variables"]["unbound"] = "scalar"
        invalid_rule["rules"][0]["right"]["args"][-1] = "unbound"
        with self.assertRaisesRegex(ValueError, "unbound right-side"):
            prepare(invalid_rule)

    def test_subprocess_results_are_deterministic(self):
        payload = json.dumps(self.job())
        outputs = [subprocess.run([sys.executable, str(DRIVER)], input=payload,
                                  capture_output=True, text=True, check=True).stdout for _ in range(2)]
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(json.loads(outputs[0])["receipt"]["version"], "14.0.0")


if __name__ == "__main__":
    unittest.main()
