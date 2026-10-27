"""Release compilation may prepare an update without touching any running app."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/reloads.sh'

class ReleaseBuildOnlyTests(unittest.TestCase):
    def test_build_only_produces_artifact_without_launch_or_staging(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fakebin = root / 'bin'
            fakebin.mkdir()
            dd = root / 'derived'
            events = root / 'events'
            build = fakebin / 'xcodebuild'
            build.write_text('#!/bin/sh\nmkdir -p "$TEST_RELEASE_DD/Build/Products/Release/cmux.app"\nprintf built > "$TEST_RELEASE_DD/Build/Products/Release/cmux.app/fixture"\nprintf build >> "$TEST_RELEASE_EVENTS"\n')
            build.chmod(0o755)
            for command in ('open', 'pkill'):
                stub = fakebin / command
                stub.write_text('#!/bin/sh\nprintf unsafe >> "$TEST_RELEASE_EVENTS"\nexit 99\n')
                stub.chmod(0o755)
            env = dict(os.environ, PATH=str(fakebin) + ':/usr/bin:/bin',
                       TEST_RELEASE_DD=str(dd), TEST_RELEASE_EVENTS=str(events))
            result = subprocess.run(['/bin/bash', str(SCRIPT), '--tag', 'guard-' + uuid.uuid4().hex,
                                     '--derived-data', str(dd), '--build-only'],
                                    cwd=root, env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(events.read_text(), 'build')
            self.assertEqual([p.name for p in (dd / 'Build/Products/Release').iterdir()], ['cmux.app'])
            self.assertEqual((dd / 'Build/Products/Release/cmux.app/fixture').read_text(), 'built')

if __name__ == '__main__':
    unittest.main()
