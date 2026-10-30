import copy
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/pr-cycle/scripts'))
from use_local_clis import update_profiles, command_line, MANAGED_COMMAND


class LocalCliProfilesTest(unittest.TestCase):
    def test_preserves_permissions_custom_profiles_commands_and_other_executors(self):
        original = {'executors': {
            'CODEX': {
                'DEFAULT': {'CODEX': {'model': 'unavailable', 'sandbox': 'read-only', 'env': {'EXAMPLE': 'value'}, 'additional_params': ['--example']}},
                'APPROVALS': {'CODEX': {'sandbox': 'workspace-write', 'ask_for_approval': 'unless-trusted'}},
                'HIGH': {'CODEX': {'base_command_override': 'my-wrapper', 'model': 'custom-model'}},
                'CUSTOM': {'CODEX': {'model': 'custom-model'}},
            },
            'CLAUDE_CODE': {'OPUS': {'CLAUDE_CODE': {'model': 'opus', 'approvals': True}}},
            'OTHER': {'DEFAULT': {'OTHER': {}}},
        }}
        before = copy.deepcopy(original)
        actual, changed, skipped = update_profiles(original, {'CODEX': 'local-codex', 'CLAUDE_CODE': 'local-claude'})
        self.assertEqual(original, before)
        self.assertEqual(actual['executors']['CODEX']['DEFAULT']['CODEX'], {
            'base_command_override': 'local-codex', 'sandbox': 'read-only', 'env': {
                'EXAMPLE': 'value', 'PR_CYCLE_LOCAL_CLI': '1', MANAGED_COMMAND: 'local-codex'},
            'additional_params': ['--example']})
        self.assertEqual(actual['executors']['CODEX']['APPROVALS']['CODEX']['ask_for_approval'], 'unless-trusted')
        for name in ['HIGH', 'CUSTOM']:
            self.assertEqual(actual['executors']['CODEX'][name], original['executors']['CODEX'][name])
        self.assertEqual(actual['executors']['OTHER'], original['executors']['OTHER'])
        self.assertEqual(actual['executors']['CLAUDE_CODE']['OPUS']['CLAUDE_CODE']['model'], 'opus')
        self.assertEqual(len(changed), 3)
        self.assertEqual(len(skipped), 1)
        self.assertEqual(update_profiles(actual, {'CODEX': 'local-codex', 'CLAUDE_CODE': 'local-claude'})[0], actual)

    def test_moving_project_refreshes_managed_bindings_without_touching_custom_commands(self):
        original = {'executors': {'CODEX': {'DEFAULT': {'CODEX': {
            'base_command_override': 'old-machine-command',
            'env': {'PR_CYCLE_LOCAL_CLI': '1', MANAGED_COMMAND: 'old-machine-command', 'KEEP': 'yes'}, 'sandbox': 'read-only',
        }}}}}
        updated, changed, skipped = update_profiles(original, {'CODEX': 'new-machine-command'})
        self.assertEqual(updated['executors']['CODEX']['DEFAULT']['CODEX']['base_command_override'], 'new-machine-command')
        self.assertEqual(updated['executors']['CODEX']['DEFAULT']['CODEX']['env']['KEEP'], 'yes')
        self.assertEqual(changed, ['CODEX/DEFAULT'])
        self.assertEqual(skipped, [])
        self.assertEqual(updated['executors']['CODEX']['DEFAULT']['CODEX']['env'][MANAGED_COMMAND], 'new-machine-command')

    def test_ui_command_edit_preserves_entire_profile_on_restart_and_relocation(self):
        for executor in ('CODEX', 'CLAUDE_CODE'):
            with self.subTest(executor=executor):
                original = {'executors': {executor: {'DEFAULT': {executor: {}}}}}
                configured, _, _ = update_profiles(original, {executor: 'original-managed-command'})
                config = configured['executors'][executor]['DEFAULT'][executor]
                config.update(base_command_override='company-wrapper --audit', model='chosen-model',
                              additional_params=['--extra'])
                config['env']['KEEP'] = 'yes'
                before = copy.deepcopy(configured)
                for command in ('original-managed-command', 'relocated-managed-command'):
                    updated, changed, skipped = update_profiles(configured, {executor: command})
                    self.assertEqual(updated, before)
                    self.assertEqual(changed, [])
                    self.assertEqual(len(skipped), 1)

    def test_legacy_generated_bindings_migrate_with_spaces_and_both_adapters(self):
        for executor, script, tail in (
            ('CODEX', 'codex-local-bridge.mjs', []),
            ('CODEX', 'codex-local-bridge.mjs', ['--cli', '/old install/codex.exe']),
            ('CLAUDE_CODE', 'local-cli.mjs', ['claude']),
        ):
            with self.subTest(executor=executor, tail=tail):
                old = command_line(['/old node/node.exe', f'/old project/skills/pr-cycle/scripts/{script}', *tail])
                original = {'executors': {executor: {'DEFAULT': {executor: {
                    'base_command_override': old, 'env': {'PR_CYCLE_LOCAL_CLI': '1', 'KEEP': 'yes'},
                }}}}}
                updated, changed, skipped = update_profiles(original, {executor: 'new-binding'})
                config = updated['executors'][executor]['DEFAULT'][executor]
                self.assertEqual(config['base_command_override'], 'new-binding')
                self.assertEqual(config['env'][MANAGED_COMMAND], 'new-binding')
                self.assertEqual(config['env']['KEEP'], 'yes')
                self.assertEqual(skipped, [])
                self.assertEqual(len(changed), 1)

    def test_legacy_marker_or_adapter_substring_does_not_claim_custom_command(self):
        for command in ('company-wrapper', 'node /custom/codex-local-bridge.mjs',
                        'node /project/skills/pr-cycle/scripts/codex-local-bridge.mjs --custom'):
            with self.subTest(command=command):
                original = {'executors': {'CODEX': {'DEFAULT': {'CODEX': {
                    'base_command_override': command, 'model': 'keep',
                    'env': {'PR_CYCLE_LOCAL_CLI': '1'},
                }}}}}
                self.assertEqual(update_profiles(original, {'CODEX': 'new-binding'})[0], original)

    def test_clearing_command_reenables_local_binding(self):
        configured, _, _ = update_profiles({'executors': {'CODEX': {'DEFAULT': {'CODEX': {}}}}},
                                          {'CODEX': 'old-binding'})
        configured['executors']['CODEX']['DEFAULT']['CODEX'].pop('base_command_override')
        updated, _, skipped = update_profiles(configured, {'CODEX': 'new-binding'})
        self.assertEqual(updated['executors']['CODEX']['DEFAULT']['CODEX']['base_command_override'], 'new-binding')
        self.assertEqual(skipped, [])

    def test_command_preserves_paths_with_spaces(self):
        command = command_line(['C:/Program Files/node.exe', 'C:/工具/bridge.mjs', '--cli', 'C:/local tools/codex.exe'])
        self.assertIn('C:/Program Files/node.exe', command)
        self.assertIn('C:/local tools/codex.exe', command)
        self.assertNotIn('npx', command)


if __name__ == '__main__':
    unittest.main()
