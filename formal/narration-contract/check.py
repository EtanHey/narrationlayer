"""Bounded design checks plus real job-store execution, entirely in scratch dirs."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = Path(tempfile.mkdtemp(prefix="nl-contract-"))
INPUTS = OUT / "inputs"
INPUTS.mkdir()
NAMES = {"NarrationContract.tla", "SourceTrace.tla", "DrainProgress.tla", "check.py", "check.sh", "source-probe.ts", "coverage.json"}
hashes = {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest() for name in NAMES}
for name in NAMES:
    shutil.copy(HERE / name, INPUTS)
TLC = str(Path.home() / ".local/bin/tlc")
INVARIANTS = "TypeOK I01 I02 I03 I04 I05 I06 I07 I08 I09 I10"
results = {}


def require(condition, message):
    if not condition:
        raise SystemExit(str(message))


def validate_exits(records):
    for name, record in records.items():
        if "exit" in record:
            require(record["exit"] == record["expected_exit"], (name, record))


try:
    validate_exits({"self-test": {"exit": 0, "expected_exit": 12}})
except SystemExit:
    pass
else:
    raise SystemExit("Exit validation self-test failed")


def run(command, cwd=HERE):
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=120,
                            env=os.environ | {"JAVA_TOOL_OPTIONS": "-Xmx512m -XX:ActiveProcessorCount=1"})
    return result.returncode, result.stdout + result.stderr


def tlc(name, module, constants, invariants, expected=None, properties="", liveness_failure=False):
    folder = OUT / name
    folder.mkdir()
    shutil.copy(INPUTS / (module + ".tla"), folder)
    if module == "SourceTrace":
        (folder / "SourceInput.tla").write_text(
            "---- MODULE SourceInput ----\nEXTENDS SourceTrace\nObserved == " + constants + "\n====\n")
        module, constants = "SourceInput", "Observations <- Observed"
    config = ("SPECIFICATION Spec\nCONSTANTS " + constants + "\nINVARIANTS "
              + invariants + "\nCHECK_DEADLOCK FALSE\n")
    if properties:
        config += "PROPERTY " + properties + "\n"
    (folder / "run.cfg").write_text(config)
    code, output = run([TLC, "-workers", "1", "-seed", "1", "-fp", "0",
                        "-fpmem", "0.02", "-coverage", "9999", "-metadir",
                        str(folder / "states"), "-config", str(folder / "run.cfg"), module], folder)
    (folder / "tlc.out").write_text(output)
    counts = re.search(r"(\d+) states generated, (\d+) distinct states found", output)
    expected_exit = 13 if liveness_failure else 12 if expected else 0
    results[name] = {"exit": code, "expected_exit": expected_exit,
                     "counts": list(map(int, counts.groups())) if counts else None,
                     "config_sha256": hashlib.sha256(config.encode()).hexdigest(),
                     "model_sha256": hashlib.sha256((folder / (module + ".tla")).read_bytes()).hexdigest()}
    require(code == expected_exit, (name, code, output[:3000]))
    if liveness_failure:
        require("Temporal properties were violated" in output, (name, output[:3000]))
    elif expected:
        require(f"Invariant {expected} is violated" in output, (name, output[:3000]))
    else:
        require("Model checking completed. No error has been found." in output, name)
    return output


print(f"Artifacts: {OUT}", flush=True)
coverage = json.loads((INPUTS / "coverage.json").read_text())
for source, expected_hash in coverage["source_sha256"].items():
    require(hashlib.sha256((ROOT / source).read_bytes()).hexdigest() == expected_hash, (
        "SOURCE SYNC REQUIRED: inspect behavior, update map and scratch proof before moving sync", source))

# Mutate actual source, execute its exports, then restore the identical bytes.
# The replacement selects the function, not the earlier initializeJob unlink.
original = (ROOT / "src/job-store.ts").read_text()
source = OUT / "job-store.ts"
for variant, function, unlink in [("baseline", None, None),
                                 ("break-done", "markDone", "failedPath"),
                                 ("break-failed", "markFailed", "donePath"),
                                 ("restored", None, None)]:
    text = original
    if function:
        needle = (f"export async function {function}(jobId: string, dataDir = getDataDir()): Promise<void> {{\n"
                  f"  const paths = pathsForJob(jobId, dataDir);\n  await rm(paths.{unlink}, {{ force: true }});")
        require(text.count(needle) == 1, "Mutation target drifted; review source")
        text = text.replace(needle, needle.rsplit("\n", 1)[0])
    source.write_text(text)
    data = OUT / variant
    code, output = run(["bun", str(INPUTS / "source-probe.ts"), source.as_uri(), str(data)])
    require(code == 0, output)
    observations = json.loads((data / "observations.json").read_text())
    records = ", ".join("[done |-> %s, failed |-> %s]" %
                        (str(x["done"]).upper(), str(x["failed"]).upper()) for x in observations)
    tlc("source-" + variant, "SourceTrace", "<<" + records + ">>",
        "LegacyExclusive", "LegacyExclusive" if function else None)
require(source.read_text() == original, "Scratch source was not restored")

output = tlc("contract-safe", "NarrationContract", 'Mutant = "none"', INVARIANTS)
actions = {name: {"distinct": int(distinct), "transitions": int(total)}
           for name, distinct, total in re.findall(
               r"^<(\w+) line .*?>: (\d+):(\d+)$", output, re.M)}
for action in coverage["required_actions"]:
    require(actions.get(action, {}).get("transitions", 0) > 0, ("Uncovered action", action))
results["action_coverage"] = actions
for mutant, invariant in coverage["model_mutants"].items():
    ordered = invariant + " " + " ".join(x for x in INVARIANTS.split() if x != invariant)
    tlc(mutant, "NarrationContract", f'Mutant = "{mutant}"', ordered, invariant)
tlc("C21-witness", "NarrationContract", 'Mutant = "none"', "NoLateFailure", "NoLateFailure")
tlc("responsive-progress", "DrainProgress", "Responsive = TRUE", "Safe", properties="EventuallySafe")
tlc("unresponsive-safety", "DrainProgress", "Responsive = FALSE", "Safe")
tlc("unresponsive-progress", "DrainProgress", "Responsive = FALSE", "Safe", properties="EventuallySafe", liveness_failure=True)
validate_exits(results)
require(all(hashlib.sha256((HERE / name).read_bytes()).hexdigest() == digest for name, digest in hashes.items()), "Inputs changed during verification")
require((ROOT / "src/job-store.ts").read_text() == original, "Product source changed during verification")
results["sha256"] = hashes
results["head"] = run(["git", "rev-parse", "HEAD"], ROOT)[1].strip()
(OUT / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps(results, indent=2))
print("CHECKS_PASS; I01-I10 DESIGN-LEVEL: each implementing PR must bind real code; see coverage.json")
