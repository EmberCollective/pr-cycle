"""Atomic workflow history for the pinned local Kanban SQLite database.

Only pr_cycle_* objects are owned here. Native tasks are never written by this
helper; SQLite triggers capture UI, MCP and background updates in their original
transaction, even when the proxy/browser is stopped.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid


def default_database():
    if sys.platform == 'win32':
        return Path(os.environ['APPDATA']) / 'bloop/vibe-kanban/data/db.sqlite'
    if sys.platform == 'darwin':
        return Path.home() / 'Library/Application Support/ai.bloop.vibe-kanban/db.sqlite'
    return Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'vibe-kanban/db.sqlite'


def connect(filename):
    # mode=rw prevents a typo from creating a second, empty backend database.
    db = sqlite3.connect(Path(filename).resolve().as_uri() + '?mode=rw', uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db


SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS pr_cycle_tracking_meta (version INTEGER NOT NULL);
INSERT INTO pr_cycle_tracking_meta SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pr_cycle_tracking_meta);
CREATE TABLE IF NOT EXISTS pr_cycle_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id BLOB NOT NULL, project_id BLOB NOT NULL,
    status TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
    round INTEGER NOT NULL DEFAULT 1,
    entered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    exited_at TEXT, baseline INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pr_cycle_nodes_project ON pr_cycle_nodes(project_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS pr_cycle_nodes_current ON pr_cycle_nodes(task_id) WHERE exited_at IS NULL;
CREATE TABLE IF NOT EXISTS pr_cycle_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source INTEGER NOT NULL REFERENCES pr_cycle_nodes(id),
    target INTEGER NOT NULL REFERENCES pr_cycle_nodes(id),
    kind TEXT NOT NULL CHECK(kind IN ('sequence','return','integrate')),
    note TEXT NOT NULL DEFAULT '', automatic INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(source,target,kind), CHECK(source != target)
);
CREATE INDEX IF NOT EXISTS pr_cycle_edges_target ON pr_cycle_edges(target);
INSERT INTO pr_cycle_nodes(task_id,project_id,status,title,description,baseline)
SELECT id,project_id,status,title,description,1 FROM tasks t
WHERE NOT EXISTS (SELECT 1 FROM pr_cycle_nodes n WHERE n.task_id=t.id);
CREATE TRIGGER IF NOT EXISTS pr_cycle_task_created AFTER INSERT ON tasks BEGIN
    INSERT INTO pr_cycle_nodes(task_id,project_id,status,title,description)
    VALUES(NEW.id,NEW.project_id,NEW.status,NEW.title,NEW.description);
END;
CREATE TRIGGER IF NOT EXISTS pr_cycle_task_transition AFTER UPDATE OF status ON tasks
WHEN OLD.status != NEW.status BEGIN
    UPDATE pr_cycle_nodes SET title=OLD.title,description=OLD.description,
        exited_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE task_id=OLD.id AND exited_at IS NULL;
    INSERT INTO pr_cycle_nodes(task_id,project_id,status,title,description,round)
    SELECT NEW.id,NEW.project_id,NEW.status,NEW.title,NEW.description,round +
        CASE WHEN NEW.status != 'cancelled' AND (
            OLD.status IN ('done','cancelled') OR
            (OLD.status='inreview' AND NEW.status IN ('todo','inprogress')) OR
            (OLD.status='inprogress' AND NEW.status='todo')) THEN 1 ELSE 0 END
    FROM pr_cycle_nodes WHERE task_id=OLD.id ORDER BY id DESC LIMIT 1;
    INSERT INTO pr_cycle_edges(source,target,kind,note,automatic)
    SELECT previous.id,current.id,
        CASE WHEN current.round>previous.round THEN 'return' ELSE 'sequence' END,
        CASE WHEN current.round>previous.round THEN '状态回退，待补充原因' ELSE '' END,1
    FROM pr_cycle_nodes current JOIN pr_cycle_nodes previous ON previous.id=(
        SELECT max(id) FROM pr_cycle_nodes WHERE task_id=NEW.id AND id<current.id)
    WHERE current.task_id=NEW.id AND current.exited_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS pr_cycle_task_edited AFTER UPDATE OF title,description ON tasks
WHEN OLD.status=NEW.status BEGIN
    UPDATE pr_cycle_nodes SET title=NEW.title,description=NEW.description
    WHERE task_id=NEW.id AND exited_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS pr_cycle_task_deleted AFTER DELETE ON tasks BEGIN
    UPDATE pr_cycle_nodes SET exited_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE task_id=OLD.id AND exited_at IS NULL;
END;
COMMIT;
"""


def install(filename):
    with closing(connect(filename)) as db:
        columns = {row['name'] for row in db.execute('PRAGMA table_info(tasks)')}
        if not {'id', 'project_id', 'title', 'description', 'status'} <= columns:
            raise ValueError('Unsupported tasks schema; use the pinned local backend database')
        installed = db.execute("SELECT 1 FROM sqlite_master WHERE name='pr_cycle_tracking_meta'").fetchone()
        if installed:
            if db.execute('SELECT version FROM pr_cycle_tracking_meta').fetchone()[0] != 1:
                raise ValueError('Unsupported tracking schema version')
        else:
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            backup = Path(filename).with_name('db.before-pr-cycle-tracking-' + stamp + '.sqlite')
            with closing(sqlite3.connect(backup)) as destination:
                db.backup(destination)
        db.executescript(SCHEMA)
    return {'installed': True, 'version': 1}


def identifier(value):
    return uuid.UUID(str(value)).bytes


def graph(db, project):
    nodes = []
    for row in db.execute('''SELECT n.*,t.id IS NOT NULL AS task_exists FROM pr_cycle_nodes n
                            LEFT JOIN tasks t ON t.id=n.task_id WHERE n.project_id=? ORDER BY n.id''', (project,)):
        node = dict(row)
        node['task_id'] = str(uuid.UUID(bytes=node['task_id']))
        node['project_id'] = str(uuid.UUID(bytes=node['project_id']))
        nodes.append(node)
    edges = [dict(row) for row in db.execute('''SELECT e.* FROM pr_cycle_edges e
             JOIN pr_cycle_nodes n ON n.id=e.source WHERE n.project_id=? ORDER BY e.id''', (project,))]
    return {'nodes': nodes, 'edges': edges}


def note_value(payload):
    note = payload.get('note', '')
    if not isinstance(note, str) or len(note) > 4000:
        raise ValueError('说明须为不超过 4000 字的文本')
    return note.strip()


def execute(filename, payload):
    if not isinstance(payload, dict):
        raise ValueError('Invalid request')
    project = identifier(payload.get('project_id'))
    action = payload.get('action', 'read')
    with closing(connect(filename)) as db, db:
        # Serialize relation validation and writes; readers see one consistent graph.
        db.execute('BEGIN' if action == 'read' else 'BEGIN IMMEDIATE')
        if action == 'relate':
            sources = payload.get('sources')
            target = payload.get('target')
            kind = payload.get('kind')
            if kind not in ('sequence', 'integrate') or not isinstance(sources, list) or not 1 <= len(sources) <= 100:
                raise ValueError('请选择顺序执行或小改动整合，以及 1–100 个来源')
            if not all(type(x) is int for x in [*sources, target]):
                raise ValueError('Invalid node ID')
            node_ids = set([*sources, target])
            rows = db.execute('SELECT n.* FROM pr_cycle_nodes n JOIN tasks t ON t.id=n.task_id WHERE n.project_id=?', (project,))
            nodes = {row['id']: row for row in rows if row['id'] in node_ids}
            if len(nodes) != len(node_ids):
                raise ValueError('卡片不存在或不属于同一项目')
            for source in set(sources):
                if nodes[source]['task_id'] == nodes[target]['task_id']:
                    raise ValueError('任务内部流转自动记录，请选择不同任务')
                # Relations are a task DAG, while automatic return edges may revisit a stage.
                cycle = db.execute('''WITH RECURSIVE reachable(task_id) AS (
                    SELECT ? UNION SELECT dst.task_id FROM reachable r
                    JOIN pr_cycle_nodes src ON src.task_id=r.task_id
                    JOIN pr_cycle_edges e ON e.source=src.id AND e.automatic=0
                    JOIN pr_cycle_nodes dst ON dst.id=e.target
                ) SELECT 1 FROM reachable WHERE task_id=?''',
                                   (nodes[target]['task_id'], nodes[source]['task_id'])).fetchone()
                if cycle:
                    raise ValueError('此关联会形成任务循环，请检查执行顺序')
                db.execute('''INSERT INTO pr_cycle_edges(source,target,kind,note) VALUES(?,?,?,?)
                              ON CONFLICT(source,target,kind) DO NOTHING''', (source, target, kind, note_value(payload)))
        elif action in ('annotate', 'unlink'):
            edge = db.execute('''SELECT e.* FROM pr_cycle_edges e JOIN pr_cycle_nodes n ON n.id=e.source
                                 WHERE e.id=? AND n.project_id=?''', (payload.get('edge_id'), project)).fetchone()
            if not edge:
                raise ValueError('连线不存在')
            if action == 'unlink':
                if edge['automatic']:
                    raise ValueError('实际流转记录不能删除')
                db.execute('DELETE FROM pr_cycle_edges WHERE id=?', (edge['id'],))
            else:
                db.execute('UPDATE pr_cycle_edges SET note=? WHERE id=?', (note_value(payload), edge['id']))
        elif action != 'read':
            raise ValueError('Unknown action')
        return graph(db, project)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=None)
    parser.add_argument('--install', action='store_true')
    args = parser.parse_args()
    filename = args.db or default_database()
    try:
        data = install(filename) if args.install else execute(filename, json.load(sys.stdin))
        print(json.dumps({'success': True, 'data': data}, ensure_ascii=True))
    except (ValueError, TypeError, sqlite3.Error, OSError) as error:
        print(json.dumps({'success': False, 'message': str(error)}, ensure_ascii=True))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
