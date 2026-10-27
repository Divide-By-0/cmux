"""Exercise the deferred updater with disposable bundles and real atomic swaps."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import select
import subprocess
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    'deferred_update', Path(__file__).resolve().parents[1] / 'scripts/defer-cmux-update.py')
update = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(update)


class DeferredUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.target, self.payload = root / 'installed.app', root / 'payload.app'
        self.manifest = root / 'update.json'
        for bundle, value in [(self.target, b'original'), (self.payload, b'patched')]:
            (bundle / 'Contents/MacOS').mkdir(parents=True)
            (bundle / 'Contents/_CodeSignature').mkdir()
            (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps(
                dict(CFBundleIdentifier=update.BUNDLE_ID, CFBundleExecutable='cmux')))
            (bundle / 'Contents/MacOS/cmux').write_bytes(value)
            (bundle / 'Contents/_CodeSignature/CodeResources').write_bytes(value)
        update.prepare(self.payload, self.target, self.manifest, 'tested-sha', validator=lambda _: None)

    def apply(self, **kwargs):
        return update.apply_once(self.manifest, process_finder=kwargs.pop('process_finder', lambda: []),
                                 validator=kwargs.pop('validator', lambda _: None), **kwargs)

    def binary(self, bundle):
        return (bundle / 'Contents/MacOS/cmux').read_bytes()

    def test_running_app_is_untouched_and_validation_is_deferred(self):
        result = self.apply(process_finder=lambda: [12345],
                            validator=lambda _: self.fail('must wait before installation'))
        self.assertEqual(result, dict(state='waiting', pids=[12345]))
        self.assertEqual(self.binary(self.target), b'original')
        self.assertEqual(self.binary(self.payload), b'patched')

    def test_atomic_install_keeps_original_and_is_idempotent(self):
        self.assertEqual(self.apply()['state'], 'installed')
        self.assertEqual(self.binary(self.target), b'patched')
        self.assertEqual(self.binary(self.payload), b'original')
        self.assertEqual(self.apply()['state'], 'installed')
        self.assertEqual(self.binary(self.payload), b'original')

    def test_tampered_payload_is_refused(self):
        (self.payload / 'Contents/MacOS/cmux').write_bytes(b'tampered')
        with self.assertRaises(update.UpdateRefused):
            self.apply()
        self.assertEqual(self.binary(self.target), b'original')

    def test_newer_installed_app_is_not_overwritten(self):
        (self.target / 'Contents/MacOS/cmux').write_bytes(b'new-official-update')
        with self.assertRaises(update.UpdateRefused):
            self.apply()
        self.assertEqual(self.binary(self.target), b'new-official-update')

    def test_relaunch_during_validation_defers_again(self):
        finder = mock.Mock(side_effect=[[], [23456]])
        self.assertEqual(self.apply(process_finder=finder)['state'], 'waiting')
        self.assertEqual(self.binary(self.target), b'original')

    def test_signature_failure_leaves_installed_app_intact(self):
        def invalid(_):
            raise update.UpdateRefused('invalid signature')
        with self.assertRaises(update.UpdateRefused):
            self.apply(validator=invalid)
        self.assertEqual(self.binary(self.target), b'original')

    def test_failed_exchange_leaves_update_pending(self):
        def failed(*_):
            raise OSError('exchange refused')
        with self.assertRaises(OSError):
            self.apply(exchange=failed)
        self.assertEqual(self.binary(self.target), b'original')
        self.assertEqual(json.loads(self.manifest.read_text())['state'], 'pending')

    def test_recovers_after_exchange_before_receipt_write(self):
        with mock.patch.object(update, 'write_record', side_effect=OSError('interrupted receipt')):
            with self.assertRaises(OSError):
                self.apply()
        self.assertEqual(self.binary(self.target), b'patched')
        self.assertEqual(self.apply()['state'], 'installed')
        self.assertEqual(self.binary(self.payload), b'original')

    def test_existing_pending_manifest_is_not_replaced(self):
        before = self.manifest.read_bytes()
        with self.assertRaises(update.UpdateRefused):
            update.prepare(self.payload, self.target, self.manifest, 'other-sha', validator=lambda _: None)
        self.assertEqual(self.manifest.read_bytes(), before)

    @unittest.skipUnless(hasattr(select, 'kqueue'), 'macOS process-exit notification')
    def test_watcher_installs_only_after_disposable_process_exits(self):
        child = subprocess.Popen(['/bin/sleep', '0.2'])
        self.addCleanup(lambda: child.wait(timeout=5))
        def pids():
            return [child.pid] if child.poll() is None else []
        def validate(_):
            self.assertIsNotNone(child.poll(), 'installer ran while the process was alive')
        with contextlib.redirect_stdout(io.StringIO()):
            result = update.watch(self.manifest, process_finder=pids, validator=validate)
        self.assertEqual(result['state'], 'installed')
        self.assertEqual(self.binary(self.target), b'patched')


if __name__ == '__main__':
    unittest.main()
