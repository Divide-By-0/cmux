#!/usr/bin/env python3
"""Fold webviews-tests.sh's repeated `bun test` runs into one receipt and an MQ-flakes list.

    bun_tests_receipt.py --receipt R.json --flaky-out F.jsonl --sha SHA --jobs N --repeats N \
        --timeout-ms N --bun-version V --package NAME=DIR [--package ...]
    bun_tests_receipt.py --selftest

Each package DIR holds what webviews-tests.sh wrote: `files` (the NUL-separated test files it gave
bun), `command` (the bun command line), and per repeat i `run-i.xml` (bun's junit reporter),
`run-i.log` (bun's console reporter) and `run-i.meta` (`EXIT SECONDS`).

Counts come from bun: the junit root's tests/failures/skipped and the console summary's
pass/skip/fail/error lines. bun's junit leaves out a file that failed to load (or whose worker
died), so a test file given to bun with no junit testsuite counts as a failed `(file)` entry.

Across the complete repeats (junit written, no wall-clock timeout) a test with a pass and a fail
is flaky: it goes to the flake list, one JSON line per (test, pointer), and does not fail the run,
as Chromium's test launcher reports a pass on retry (base/test/launcher/test_launcher.cc). A test
that fails in every repeat where it ran is failing. Exit 1 when a test is failing or a repeat is
incomplete, else 0.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

SCHEMA = "cmux.oracle.bun-tests.v1"
FILE_ENTRY = "(file)"
MESSAGE_LIMIT = 500
CONSOLE_COUNT = re.compile(r"^\s*(\d+) (pass|skip|todo|fail|error)s?\s*$")
CONSOLE_RAN = re.compile(r"^Ran (\d+) tests? across (\d+) files?\.")
TIMEOUT_EXITS = {124, 137}


@dataclass
class Outcome:
    state: str  # pass | fail | skip
    file: str
    line: int | None
    message: str = ""


@dataclass
class Repeat:
    index: int
    exit: int | None
    seconds: int | None
    complete: bool
    reason: str = ""
    junit_totals: dict[str, float] = field(default_factory=dict)
    console_totals: dict[str, int] = field(default_factory=dict)
    files_missing: list[str] = field(default_factory=list)
    outcomes: dict[str, Outcome] = field(default_factory=dict)


def read_files(package_dir: Path) -> list[str]:
    raw = (package_dir / "files").read_bytes()
    return [item.decode().removeprefix("./") for item in raw.split(b"\0") if item]


def read_meta(path: Path) -> tuple[int | None, int | None]:
    try:
        parts = path.read_text(encoding="utf-8").split()
        return int(parts[0]), int(parts[1])
    except (OSError, ValueError, IndexError):
        return None, None


def console_totals(log: Path) -> dict[str, int]:
    totals: dict[str, int] = {}
    try:
        lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return totals
    for line in lines:
        if match := CONSOLE_COUNT.match(line):
            totals[match.group(2)] = int(match.group(1))
        elif match := CONSOLE_RAN.match(line):
            totals["tests"], totals["files"] = int(match.group(1)), int(match.group(2))
    return totals


def failure_message(case: ET.Element) -> str:
    for tag in ("failure", "error"):
        element = case.find(tag)
        if element is not None:
            text = element.get("message") or element.text or tag
            return text.strip()[:MESSAGE_LIMIT]
    return ""


def case_state(case: ET.Element) -> str:
    if case.find("failure") is not None or case.find("error") is not None:
        return "fail"
    if case.find("skipped") is not None:
        return "skip"
    return "pass"


def walk(suite: ET.Element, chain: list[str], file: str, seen: dict[str, int], out: dict[str, Outcome]) -> None:
    for child in suite:
        if child.tag == "testsuite":
            walk(child, [*chain, child.get("name", "")], file, seen, out)
        elif child.tag == "testcase":
            line_text = child.get("line")
            line = int(line_text) if line_text and line_text.isdigit() else None
            base = " > ".join([f"{file}:{line}" if line else file, *chain, child.get("name", "")])
            # test.each rows share a name and a line; the row's order tells them apart.
            seen[base] = seen.get(base, 0) + 1
            key = base if seen[base] == 1 else f"{base} #{seen[base]}"
            out[key] = Outcome(case_state(child), file, line, failure_message(child))


def read_repeat(package_dir: Path, index: int, expected: list[str]) -> Repeat:
    exit_code, seconds = read_meta(package_dir / f"run-{index}.meta")
    repeat = Repeat(index, exit_code, seconds, complete=False)
    repeat.console_totals = console_totals(package_dir / f"run-{index}.log")
    if exit_code is None:
        repeat.reason = "no run record"
        return repeat
    if exit_code in TIMEOUT_EXITS:
        repeat.reason = f"wall-clock timeout (exit {exit_code})"
        return repeat
    try:
        root = ET.parse(package_dir / f"run-{index}.xml").getroot()
    except (OSError, ET.ParseError) as error:
        repeat.reason = f"no junit report: {error}"
        return repeat
    repeat.complete = True
    for name in ("tests", "failures", "skipped", "assertions", "time"):
        value = root.get(name)
        if value is not None:
            repeat.junit_totals[name] = float(value) if name == "time" else int(value)
    reported: set[str] = set()
    for suite in root.findall("testsuite"):
        file = (suite.get("file") or suite.get("name") or "").removeprefix("./")
        reported.add(file)
        walk(suite, [], file, {}, repeat.outcomes)
    for file in expected:
        if file in reported:
            repeat.outcomes[f"{file} > {FILE_ENTRY}"] = Outcome("pass", file, None)
        else:
            repeat.files_missing.append(file)
            repeat.outcomes[f"{file} > {FILE_ENTRY}"] = Outcome(
                "fail", file, None, "bun's junit has no testsuite for this file: it failed to load or its worker died; see the log"
            )
    return repeat


def classify(prefix: str, repeats: list[Repeat]) -> tuple[dict[str, list[dict]], dict[str, int], dict]:
    complete = [repeat for repeat in repeats if repeat.complete]
    keys = sorted({key for repeat in complete for key in repeat.outcomes})
    failing: list[dict] = []
    flaky: list[dict] = []
    counts = {"tests_unique": 0, "passed_every_repeat": 0, "skipped_every_repeat": 0}
    for key in keys:
        seen = [repeat.outcomes.get(key) for repeat in complete]
        states = [outcome.state if outcome else "absent" for outcome in seen]
        present = [outcome for outcome in seen if outcome]
        first = present[0]
        is_test = not key.endswith(f" > {FILE_ENTRY}")
        counts["tests_unique"] += is_test
        has_pass, has_fail = "pass" in states, "fail" in states
        if not has_fail:
            if is_test and all(state == "pass" for state in states):
                counts["passed_every_repeat"] += 1
            elif is_test and all(state == "skip" for state in states):
                counts["skipped_every_repeat"] += 1
            continue
        message = next((outcome.message for outcome in present if outcome.state == "fail"), "")
        pointer = f"{prefix}/{first.file}" + (f":{first.line}" if first.line else "")
        entry = {"test": f"{prefix}/{key}", "pointer": pointer, "outcomes": states, "first_failure": message}
        (flaky if has_pass else failing).append(entry)
    summary = {
        "repeats_complete": len(complete),
        "repeats_incomplete": [{"index": repeat.index, "reason": repeat.reason} for repeat in repeats if not repeat.complete],
    }
    return {"failing": failing, "flaky": flaky}, counts, summary


def package_report(name: str, package_dir: Path, repeat_count: int) -> tuple[dict, list[dict]]:
    expected = read_files(package_dir)
    repeats = [read_repeat(package_dir, index, expected) for index in range(1, repeat_count + 1)]
    lists, counts, summary = classify(name, repeats)
    command_file = package_dir / "command"
    report = {
        "command": command_file.read_text(encoding="utf-8").strip() if command_file.exists() else "",
        "files_expected": len(expected),
        "repeats": [
            {
                "index": repeat.index,
                "exit": repeat.exit,
                "seconds": repeat.seconds,
                "complete": repeat.complete,
                "reason": repeat.reason,
                "junit": repeat.junit_totals,
                "console": repeat.console_totals,
                "files_missing_from_junit": repeat.files_missing,
                "log": str(package_dir / f"run-{repeat.index}.log"),
            }
            for repeat in repeats
        ],
        **summary,
        **counts,
        "failing_count": len(lists["failing"]),
        "flaky_count": len(lists["flaky"]),
        "failing": lists["failing"],
    }
    return report, lists["flaky"]


def build(args: argparse.Namespace) -> int:
    packages: dict[str, dict] = {}
    flakes: list[dict] = []
    for spec in args.package:
        name, _, directory = spec.partition("=")
        report, flaky = package_report(name, Path(directory), args.repeats)
        packages[name] = report
        flakes += [{"queue": "MQ-flakes", "source": "webviews-tests.sh", "package": name, "sha": args.sha, **item} for item in flaky]
    receipt = {
        "schema": SCHEMA,
        "sha": args.sha,
        "dirty": args.dirty,
        "host": platform.node(),
        "cpus": os.cpu_count(),
        "bun": args.bun_version,
        "jobs": args.jobs,
        "repeats": args.repeats,
        "timeout_ms": args.timeout_ms,
        "flaky_out": str(args.flaky_out),
        "packages": packages,
    }
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=1) + "\n", encoding="utf-8")
    args.flaky_out.parent.mkdir(parents=True, exist_ok=True)
    args.flaky_out.write_text("".join(json.dumps(item, sort_keys=True) + "\n" for item in flakes), encoding="utf-8")
    red = False
    for name, report in packages.items():
        totals = ", ".join(
            f"#{item['index']} " + (f"{item['junit'].get('tests', 0)} tests {item['junit'].get('failures', 0)} failed {item['junit'].get('skipped', 0)} skipped {item['seconds']}s" if item["complete"] else f"incomplete: {item['reason']}")
            for item in report["repeats"]
        )
        print(f"{name}: {report['files_expected']} files; {totals}")
        print(f"{name}: {report['tests_unique']} tests, {report['passed_every_repeat']} passed every repeat, {report['failing_count']} failing, {report['flaky_count']} flaky")
        for item in report["failing"]:
            print(f"  FAIL {item['test']} {item['outcomes']}")
        red = red or bool(report["failing"]) or bool(report["repeats_incomplete"])
    print(f"receipt: {args.receipt}")
    print(f"flake list ({len(flakes)}): {args.flaky_out}")
    return 1 if red else 0


def junit(cases: dict[str, list[tuple[str, str]]]) -> str:
    suites = []
    for file, rows in cases.items():
        body = []
        for line, (name, state) in enumerate(rows, start=1):
            inner = {"fail": '<failure message="boom">boom</failure>', "skip": "<skipped />"}.get(state, "")
            body.append(f'<testcase name="{name}" file="{file}" line="{line if name != "dup" else 9}">{inner}</testcase>')
        suites.append(f'<testsuite name="{file}" file="{file}"><testsuite name="group">{"".join(body)}</testsuite></testsuite>')
    return f'<testsuites name="bun test" tests="0" failures="0" skipped="0">{"".join(suites)}</testsuites>'


def selftest() -> int:
    runs = [
        {"a.test.ts": [("steady", "pass"), ("sometimes", "pass"), ("broken", "fail"), ("off", "skip"), ("dup", "pass"), ("dup", "fail")], "b.test.ts": [("x", "pass")]},
        {"a.test.ts": [("steady", "pass"), ("sometimes", "fail"), ("broken", "fail"), ("off", "skip"), ("dup", "pass"), ("dup", "fail")]},
        {"a.test.ts": [("steady", "pass"), ("sometimes", "pass"), ("broken", "fail"), ("off", "skip"), ("dup", "pass"), ("dup", "fail")], "b.test.ts": [("x", "pass")]},
    ]
    with tempfile.TemporaryDirectory() as temp:
        package = Path(temp) / "pkg"
        package.mkdir()
        (package / "files").write_bytes(b"./a.test.ts\0./b.test.ts\0")
        for index, run in enumerate(runs, start=1):
            (package / f"run-{index}.xml").write_text(junit(run), encoding="utf-8")
            (package / f"run-{index}.log").write_text(" 4 pass\n 1 skip\n 2 fail\n 1 error\nRan 7 tests across 2 files. [1.00s]\n", encoding="utf-8")
            (package / f"run-{index}.meta").write_text("1 3\n", encoding="utf-8")
        (package / "run-4.meta").write_text("124 600\n", encoding="utf-8")
        report, flaky = package_report("pkg", package, 4)
        failing = sorted(item["test"] for item in report["failing"])
        checks = {
            "failing": failing == ["pkg/a.test.ts:3 > group > broken", "pkg/a.test.ts:9 > group > dup #2"],
            "flaky": sorted(item["test"] for item in flaky) == ["pkg/a.test.ts:2 > group > sometimes", "pkg/b.test.ts > (file)"],
            "flaky outcomes": next(item for item in flaky if "sometimes" in item["test"])["outcomes"] == ["pass", "fail", "pass"],
            "pointer": next(item for item in flaky if "sometimes" in item["test"])["pointer"] == "pkg/a.test.ts:2",
            "missing file": report["repeats"][1]["files_missing_from_junit"] == ["b.test.ts"],
            "timeout incomplete": report["repeats_incomplete"] == [{"index": 4, "reason": "wall-clock timeout (exit 124)"}],
            "console": report["repeats"][0]["console"] == {"pass": 4, "skip": 1, "fail": 2, "error": 1, "tests": 7, "files": 2},
            "skipped": report["skipped_every_repeat"] == 1,
            "passed": report["passed_every_repeat"] == 2,
            "unique": report["tests_unique"] == 7,
        }
    bad = [name for name, ok in checks.items() if not ok]
    print("selftest: " + ("ok" if not bad else "FAILED " + ", ".join(bad)))
    return 1 if bad else 0


def main(argv: list[str]) -> int:
    if argv == ["--selftest"]:
        return selftest()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--flaky-out", type=Path, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--dirty", action="store_true")
    parser.add_argument("--jobs", type=int, required=True)
    parser.add_argument("--repeats", type=int, required=True)
    parser.add_argument("--timeout-ms", type=int, required=True)
    parser.add_argument("--bun-version", required=True)
    parser.add_argument("--package", action="append", required=True, metavar="NAME=DIR")
    return build(parser.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
