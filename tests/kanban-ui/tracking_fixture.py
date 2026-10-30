"""Isolated native-task writer for tracking HTTP/browser tests."""
import json
from pathlib import Path
import sqlite3
import sys
import uuid

PROJECT = '11111111-1111-4111-8111-111111111111'
IDS = [f'22222222-2222-4222-8222-{i:012d}' for i in range(1, 5)]
filename, action = sys.argv[1:3]
db = sqlite3.connect(filename)
db.row_factory = sqlite3.Row
try:
    if action == 'init':
        db.execute('CREATE TABLE tasks(id BLOB PRIMARY KEY,project_id BLOB,title TEXT,description TEXT,status TEXT)')
        for task, title in zip(IDS, ['登录修复', '按钮文案', '小改动整合', '独立任务']):
            db.execute('INSERT INTO tasks VALUES(?,?,?,?,?)', (uuid.UUID(task).bytes, uuid.UUID(PROJECT).bytes, title, '验收：保持原有功能正常', 'todo'))
        db.commit()
    if action == 'update':
        body = json.load(sys.stdin)
        db.execute('UPDATE tasks SET status=? WHERE id=?', (body['status'], uuid.UUID(body['id']).bytes))
        db.commit()
    tasks = []
    for row in db.execute('SELECT * FROM tasks ORDER BY id'):
        task = dict(row)
        task.update(id=str(uuid.UUID(bytes=task['id'])), project_id=PROJECT,
                    has_in_progress_attempt=False, last_attempt_failed=False,
                    executor='CLAUDE_CODE', parent_workspace_id=None,
                    created_at='2026-10-30T00:00:00Z', updated_at='2026-10-30T00:00:00Z')
        tasks.append(task)
    print(json.dumps({'success': True, 'data': tasks}, ensure_ascii=True))
finally:
    db.close()
