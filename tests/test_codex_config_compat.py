import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/pr-cycle/scripts'))
import codex_config_compat as compat
from use_local_clis import adapt_managed_codex_configs


class ConfigCompatTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pr-cycle-compat-test-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.config = self.home / 'config.toml'
        self.env = {**os.environ, 'CODEX_HOME': str(self.home)}
        self.messages = []
        self.original = (b'# keep formatting\r\ndisable_response_storage = true # obsolete\r\n'
                         b'model = "keep-model"\r\n[model_providers.local]\r\n'
                         b'name = "private-value"\r\ndisable_response_storage = false\r\n')
        self.config.write_bytes(self.original)

    def adapt(self, **kwargs):
        return compat.adapt_codex_config({'command': 'codex'}, self.env,
                                         report=self.messages.append, **kwargs)

    def test_confirmed_rejection_backs_up_only_removes_root_key_and_is_idempotent(self):
        with patch.object(compat, 'rejects_obsolete_setting', return_value=True) as probe:
            self.assertTrue(self.adapt())
            self.assertFalse(self.adapt())
            self.assertEqual(probe.call_count, 1)
        self.assertEqual(self.config.read_bytes(), self.original.replace(
            b'disable_response_storage = true # obsolete\r\n', b''))
        backups = list(self.home.glob('*.bak'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), self.original)
        self.assertNotIn('private-value', '\n'.join(self.messages))
        self.assertFalse(list(self.home.glob('*.lock')))

    def test_supported_or_unconfirmed_cli_preserves_config(self):
        with patch.object(compat, 'rejects_obsolete_setting', return_value=False):
            self.assertFalse(self.adapt())
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertEqual(list(self.home.glob('*.bak')), [])

    def test_preview_does_not_write_or_back_up(self):
        with patch.object(compat, 'rejects_obsolete_setting', return_value=True):
            self.assertFalse(self.adapt(check=True))
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertEqual(list(self.home.iterdir()), [self.config])
        self.assertIn('would back up', self.messages[0])

    def test_semantic_check_preserves_nested_keys_strings_comments_and_unicode(self):
        raw = ('\ufeff"disable_response_storage" = false\n'
               'note = """中文\ndisable_response_storage = true\n"""\n'
               '# disable_response_storage = true\n'
               '[nested]\ndisable_response_storage = true\n').encode('utf-8')
        expected = raw.replace(b'"disable_response_storage" = false\n', b'')
        self.assertEqual(compat.without_obsolete_setting(raw), expected)
        self.assertIsNone(compat.without_obsolete_setting(expected))
        self.assertIsNone(compat.without_obsolete_setting(b'disable_response_storage = "true"'))

    def test_unknown_keys_remain_and_malformed_toml_is_untouched(self):
        for raw in [b'disable_response_storage = true\nother_unknown = true\n',
                    b'disable_response_storage = true\n[invalid']:
            with self.subTest(raw=raw):
                self.config.write_bytes(raw)
                with patch.object(compat, 'rejects_obsolete_setting', return_value=True):
                    changed = self.adapt()
                self.assertEqual(self.config.read_bytes(), raw.replace(
                    b'disable_response_storage = true\n', b'') if changed else raw)

    def test_external_edit_during_probe_is_preserved(self):
        edited = self.original + b'# concurrent editor\r\n'
        def probe(*args):
            self.config.write_bytes(edited)
            return True
        with patch.object(compat, 'rejects_obsolete_setting', side_effect=probe):
            self.assertFalse(self.adapt())
        self.assertEqual(self.config.read_bytes(), edited)
        self.assertEqual(list(self.home.glob('*.bak')), [])

    def test_busy_lock_missing_parser_and_probe_timeout_do_not_change_config(self):
        lock = self.home / 'config.toml.pr-cycle-compat.lock'
        lock.write_text('another launcher')
        with patch.object(compat, 'rejects_obsolete_setting', return_value=True):
            self.assertFalse(self.adapt())
        self.assertEqual(lock.read_text(), 'another launcher')
        lock.unlink()
        with patch.object(compat, 'tomllib', None):
            self.assertFalse(self.adapt())
        with patch.object(compat, 'rejects_obsolete_setting', side_effect=subprocess.TimeoutExpired('codex', 15)):
            self.assertFalse(self.adapt())
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_backup_failure_never_changes_config(self):
        real_open = os.open
        def fail_backup(path, *args, **kwargs):
            if str(path).endswith('.bak'):
                raise PermissionError('cannot create backup')
            return real_open(path, *args, **kwargs)
        with patch.object(compat, 'rejects_obsolete_setting', return_value=True), patch.object(compat.os, 'open', side_effect=fail_backup):
            self.assertFalse(self.adapt())
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertFalse(list(self.home.glob('*.lock')))

    def test_probe_requires_exact_native_rejection_and_uses_synthetic_home(self):
        for diagnostic, status, expected in [
            ('unknown configuration field `disable_response_storage`', 1, True),
            ('unknown configuration field `other_key`', 1, False),
            ('unexpected argument --strict-config', 2, False),
            ('unknown configuration field `disable_response_storage`', 0, False),
        ]:
            def run(command, **kwargs):
                config = Path(kwargs['env']['CODEX_HOME']) / 'config.toml'
                self.assertNotEqual(config, self.config)
                self.assertEqual(config.read_text(), 'disable_response_storage = true\n')
                self.assertEqual(kwargs['input'], '')
                self.assertEqual(command[-2:], ['--strict-config', 'app-server'])
                return subprocess.CompletedProcess(command, status, '', f'Error: {config}:1:1: {diagnostic}')
            with self.subTest(diagnostic=diagnostic, status=status), patch.object(compat.subprocess, 'run', side_effect=run):
                self.assertEqual(compat.rejects_obsolete_setting({'command': 'codex'}, self.env), expected)

    def test_startup_honors_preset_home_and_cli_and_deduplicates_managed_profiles(self):
        def preset(command, env):
            return {'CODEX': {'base_command_override': command, 'env': env}}
        profiles = {'executors': {'CODEX': {
            'DEFAULT': preset('bridge', {'CODEX_HOME': 'home-a', 'PR_CYCLE_CODEX_PATH': '/cli-a'}),
            'HIGH': preset('bridge', {'CODEX_HOME': 'home-a', 'PR_CYCLE_CODEX_PATH': '/cli-a'}),
            'MAX': preset('bridge', {'CODEX_HOME': 'home-b', 'PR_CYCLE_CODEX_PATH': '/cli-b'}),
            'CUSTOM': preset('custom-command', {'CODEX_HOME': 'untouched'}),
        }}}
        with patch('use_local_clis.probe_clis', return_value={'codex': {'available': True, 'command': 'codex'}}), \
                patch('use_local_clis.adapt_codex_config') as adapt:
            adapt_managed_codex_configs(profiles, 'bridge', check=True)
        self.assertEqual(adapt.call_count, 2)
        self.assertEqual([call.args[1]['CODEX_HOME'] for call in adapt.call_args_list], ['home-a', 'home-b'])
        self.assertEqual([call.args[1]['PR_CYCLE_CODEX_PATH'] for call in adapt.call_args_list], ['/cli-a', '/cli-b'])
        self.assertTrue(all(call.kwargs['check'] for call in adapt.call_args_list))


if __name__ == '__main__':
    unittest.main()
