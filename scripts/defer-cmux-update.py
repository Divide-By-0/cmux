#!/usr/bin/env python3
"""Install a prepared local cmux update only after all cmux apps have exited.

The payload and installed app must be on the same filesystem. An atomic
exchange preserves the previous app at the payload path for rollback. This
tool never launches an app or sends a signal to any process.
"""
import argparse
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import select
import subprocess
import sys
import tempfile
import time

BUNDLE_ID = "com.cmuxterm.app"


class UpdateRefused(RuntimeError):
    pass


def bundle_digest(bundle):
    bundle = Path(bundle)
    info = plistlib.loads((bundle / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != BUNDLE_ID or info.get("CFBundleExecutable") != "cmux":
        raise UpdateRefused("Expected a stable-identity cmux Release artifact")
    digest = hashlib.sha256()
    for name in ("Info.plist", "MacOS/cmux", "_CodeSignature/CodeResources"):
        digest.update(name.encode())
        with (bundle / "Contents" / name).open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def verify_signature(bundle):
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(bundle)],
                   check=True, capture_output=True, text=True)


def active_cmux_pids():
    # Read executable paths, not command arguments or terminal contents.
    rows = subprocess.check_output(["/bin/ps", "-axww", "-o", "pid=,comm="], text=True)
    pids = []
    for row in rows.splitlines():
        parts = row.strip().split(None, 1)
        if len(parts) == 2 and parts[1].endswith(("/Contents/MacOS/cmux", "/Contents/MacOS/cmux DEV")):
            pids.append(int(parts[0]))
    return pids


def write_record(path, record):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".update-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(record, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def prepare(payload, target, manifest, revision, validator=verify_signature):
    payload, target, manifest = map(lambda p: Path(p).resolve(), (payload, target, manifest))
    if manifest.exists():
        raise UpdateRefused("An update manifest already exists; inspect it before preparing another")
    if payload == target or target in payload.parents or payload in target.parents:
        raise UpdateRefused("Payload and installed app must be separate bundles")
    if os.stat(payload).st_dev != os.stat(target).st_dev:
        raise UpdateRefused("Atomic update requires both bundles on the same filesystem")
    validator(payload)
    record = dict(version=1, state="pending", payload=str(payload), target=str(target),
                  original_digest=bundle_digest(target), candidate_digest=bundle_digest(payload),
                  revision=revision, created_at=time.time())
    write_record(manifest, record)
    return record


def exchange_bundles(payload, target):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        fn, directory_fd = libc.renameatx_np, -2
    elif sys.platform.startswith("linux"):
        fn, directory_fd = libc.renameat2, -100
    else:
        raise UpdateRefused("No supported atomic directory exchange on this platform")
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    # Darwin RENAME_SWAP / Linux RENAME_EXCHANGE. No non-atomic fallback.
    if fn(directory_fd, os.fsencode(payload), directory_fd, os.fsencode(target), 2):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def apply_once(manifest, process_finder=active_cmux_pids, validator=verify_signature,
               exchange=exchange_bundles):
    manifest = Path(manifest)
    with manifest.with_suffix(".lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = json.loads(manifest.read_text())
        if record["version"] != 1:
            raise UpdateRefused("Unknown update manifest version")
        payload, target = Path(record["payload"]), Path(record["target"])
        installed = bundle_digest(target)
        if installed == record["candidate_digest"]:
            # Recover safely if a previous invocation exchanged the app but
            # exited before recording completion. Never exchange it back.
            record.update(state="installed", backup=str(payload))
            write_record(manifest, record)
            return dict(state="installed", revision=record["revision"])
        if record["state"] != "pending":
            raise UpdateRefused("The completed update no longer matches the installed app")
        if installed != record["original_digest"]:
            raise UpdateRefused("Installed cmux changed while waiting; refusing to overwrite it")
        pids = process_finder()
        if pids:
            return dict(state="waiting", pids=pids)
        if bundle_digest(payload) != record["candidate_digest"]:
            raise UpdateRefused("Prepared payload changed")
        validator(payload)
        if bundle_digest(target) != record["original_digest"]:
            raise UpdateRefused("Installed cmux changed during validation")
        # Recheck immediately before exchanging the bundles. A rapid user
        # relaunch defers the update again instead of interrupting that app.
        pids = process_finder()
        if pids:
            return dict(state="waiting", pids=pids)
        exchange(payload, target)
        record.update(state="installed", backup=str(payload), installed_at=time.time())
        write_record(manifest, record)
        return dict(state="installed", revision=record["revision"], backup=str(payload))


def wait_for_exit(pids):
    queue = select.kqueue()
    try:
        changes = [select.kevent(pid, filter=select.KQ_FILTER_PROC,
                                flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                fflags=select.KQ_NOTE_EXIT) for pid in pids]
        try:
            queue.control(changes, 1, None)
        except ProcessLookupError:
            pass  # It exited between the process snapshot and registration.

    finally:
        queue.close()


def watch(manifest, process_finder=active_cmux_pids, validator=verify_signature):
    if json.loads(Path(manifest).read_text())["state"] == "installed":
        return dict(state="installed", already_completed=True)
    while True:
        result = apply_once(manifest, process_finder=process_finder, validator=validator)
        print(json.dumps(result), flush=True)
        if result["state"] == "installed":
            return result
        wait_for_exit(result["pids"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    for action in ("apply", "watch", "status"):
        sub.add_parser(action).add_argument("manifest", type=Path)
    init = sub.add_parser("prepare")
    for name in ("payload", "target", "manifest", "revision"):
        init.add_argument(name)
    args = parser.parse_args()
    if args.action == "status":
        record = json.loads(args.manifest.read_text())
        print(json.dumps(dict(state=record["state"], revision=record["revision"],
                              active_pids=active_cmux_pids(), backup=record.get("backup")), indent=2))
        return
    if sys.platform != "darwin":
        parser.error("Deferred cmux installation requires macOS")
    if args.action == "prepare":
        result = prepare(args.payload, args.target, args.manifest, args.revision)
    elif args.action == "apply":
        result = apply_once(args.manifest)
    else:
        result = watch(args.manifest)
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
