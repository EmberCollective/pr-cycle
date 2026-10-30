"""Test real SQLite triggers using independent writer connections, no AI/backend."""
import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('tracking', ROOT / 'skills/pr-cycle/scripts/kanban_tracking.py')
tracking = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tracking)


class TrackingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'db.sqlite'
        self.project = uuid.uuid4()
        self.other = uuid.uuid4()
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE tasks(id BLOB PRIMARY KEY,project_id BLOB,title TEXT,description TEXT,status TEXT)')
        self.first = self.create('First')
        tracking.install(self.path)

    def create(self, title, project=None):
        key = uuid.uuid4()
        self.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?)', (key.bytes, (project or self.project).bytes, title, 'original', 'todo'))
        self.db.commit()
        return key

    def change(self, key, status, description=None):
        if description is not None:
            self.db.execute('UPDATE tasks SET description=? WHERE id=?', (description, key.bytes))
        self.db.execute('UPDATE tasks SET status=? WHERE id=?', (status, key.bytes))
        self.db.commit()

    def call(self, **payload):
        return tracking.execute(self.path, {'project_id': str(self.project), **payload})

    def test_baseline_and_idempotent_install_preserve_native_data(self):
        before = self.db.execute('SELECT * FROM tasks').fetchall()
        tracking.install(self.path)
        graph = self.call()
        self.assertEqual(len(graph['nodes']), 1)
        self.assertEqual(graph['nodes'][0]['baseline'], 1)
        self.assertEqual(graph['nodes'][0]['task_id'], str(self.first))
        self.assertEqual(before, self.db.execute('SELECT * FROM tasks').fetchall())
        backups = list(self.path.parent.glob('db.before-*.sqlite'))
        self.assertEqual(len(backups), 1)
        with closing(sqlite3.connect(backups[0])) as backup:
            self.assertEqual(backup.execute('SELECT * FROM tasks').fetchall(), before)
            self.assertFalse(backup.execute("SELECT 1 FROM sqlite_master WHERE name='pr_cycle_nodes'").fetchone())

    def test_forward_return_repeated_review_and_snapshots_survive_reconnect(self):
        self.change(self.first, 'inprogress')
        self.change(self.first, 'inreview', 'first evidence')
        self.change(self.first, 'inprogress')
        self.change(self.first, 'inreview', 'fixed evidence')
        graph = self.call()
        self.assertEqual([n['status'] for n in graph['nodes']], ['todo', 'inprogress', 'inreview', 'inprogress', 'inreview'])
        self.assertEqual([n['round'] for n in graph['nodes']], [1, 1, 1, 2, 2])
        self.assertEqual([e['kind'] for e in graph['edges']], ['sequence', 'sequence', 'return', 'sequence'])
        self.assertEqual(graph['nodes'][1]['description'], 'first evidence')
        self.assertEqual(graph['nodes'][3]['description'], 'fixed evidence')
        self.assertEqual(sum(n['exited_at'] is None for n in graph['nodes']), 1)
        self.assertEqual(self.call(), graph)  # fresh connection on every read
        self.assertEqual(self.db.execute('SELECT count(*) FROM tasks').fetchone()[0], 1)

    def test_transaction_rollback_and_noop_do_not_create_phantom_history(self):
        self.db.execute("UPDATE tasks SET status='inprogress' WHERE id=?", (self.first.bytes,))
        self.db.rollback()
        self.change(self.first, 'todo', 'edited')
        self.assertEqual(len(self.call()['nodes']), 1)
        self.assertEqual(self.call()['nodes'][0]['description'], 'edited')
        self.assertEqual(self.call()['edges'], [])

    def test_many_to_one_relations_cycle_guard_annotations_and_unlink(self):
        second = self.create('Second')
        target = self.create('Integration')
        nodes = {n['task_id']: n['id'] for n in self.call()['nodes']}
        a, b, c = [nodes[str(t)] for t in [self.first, second, target]]
        graph = self.call(action='relate', sources=[a, b], target=c, kind='integrate', note='small fixes')
        self.assertEqual(len(graph['edges']), 2)
        self.assertEqual(len(self.call(action='relate', sources=[a, b], target=c, kind='integrate')['edges']), 2)
        with self.assertRaisesRegex(ValueError, '循环'):
            self.call(action='relate', sources=[c], target=a, kind='sequence')
        self.assertEqual(len(self.call()['edges']), 2)
        edge = graph['edges'][0]
        self.assertEqual(self.call(action='annotate', edge_id=edge['id'], note='updated')['edges'][0]['note'], 'updated')
        self.assertEqual(len(self.call(action='unlink', edge_id=edge['id'])['edges']), 1)
        self.assertTrue(all(n['status'] == 'todo' for n in self.call()['nodes']))

    def test_cross_project_self_invalid_deleted_and_automatic_edge_guards(self):
        foreign = self.create('Foreign', self.other)
        foreign_id = tracking.execute(self.path, {'project_id': str(self.other)})['nodes'][0]['id']
        a = self.call()['nodes'][0]['id']
        for target in [a, foreign_id, 999999]:
            with self.assertRaises(ValueError):
                self.call(action='relate', sources=[a], target=target, kind='sequence')
        self.change(self.first, 'inprogress')
        edge = self.call()['edges'][0]
        with self.assertRaisesRegex(ValueError, '不能删除'):
            self.call(action='unlink', edge_id=edge['id'])
        self.db.execute('DELETE FROM tasks WHERE id=?', (self.first.bytes,))
        self.db.commit()
        graph = self.call()
        self.assertEqual(len(graph['nodes']), 2)
        self.assertTrue(all(n['exited_at'] and not n['task_exists'] for n in graph['nodes']))
        self.assertEqual(len(graph['edges']), 1)

    def test_multi_source_failure_is_atomic(self):
        other = self.create('Other')
        ids = {n['task_id']: n['id'] for n in self.call()['nodes']}
        a, b = ids[str(self.first)], ids[str(other)]
        with self.assertRaises(ValueError):
            self.call(action='relate', sources=[a, b], target=b, kind='integrate')
        self.assertEqual(self.call()['edges'], [])

    def test_completed_and_cancelled_tasks_reopen_in_new_round(self):
        self.change(self.first, 'done')
        self.change(self.first, 'inprogress')
        self.change(self.first, 'cancelled')
        self.change(self.first, 'todo')
        self.assertEqual([e['kind'] for e in self.call()['edges']], ['sequence', 'return', 'sequence', 'return'])
        self.assertEqual(self.call()['nodes'][-1]['round'], 3)

    def test_missing_database_is_never_created(self):
        missing = self.path.parent / 'missing.sqlite'
        with self.assertRaises(sqlite3.OperationalError):
            tracking.install(missing)
        self.assertFalse(missing.exists())


if __name__ == '__main__':
    unittest.main()
