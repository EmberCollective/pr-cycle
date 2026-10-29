#!/usr/bin/env python3
"""Validate and import batches into the local Vibe Kanban 0.0.166 board.

The ready command proposes a wave; it never starts workers or grants approval.
"""

import argparse
from contextlib import contextmanager
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib import error, parse, request
from uuid import UUID


SLUG = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}\Z")
STATUSES = {"todo", "inprogress", "inreview", "done", "cancelled"}
PARENT = "__batch__"
VERSION = "0.0.166"


class BatchError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise BatchError(message)


def text_value(value):
    return isinstance(value, str) and bool(value.strip())


def string_list(value, name, nonempty=False):
    require(isinstance(value, list) and all(text_value(x) for x in value),
            f"{name} must be a list of nonblank strings")
    require(not nonempty or bool(value), f"{name} must not be empty")
    require(len(value) == len(set(value)), f"{name} contains duplicates")


def validate(batch):
    fields = {"schema_version", "batch_id", "title", "project_id", "max_parallel", "tasks"}
    require(isinstance(batch, dict) and set(batch) == fields,
            "batch must contain exactly: " + ", ".join(sorted(fields)))
    require(type(batch["schema_version"]) is int and batch["schema_version"] == 1,
            "schema_version must be 1")
    require(isinstance(batch["batch_id"], str) and SLUG.fullmatch(batch["batch_id"]),
            "batch_id must be a lowercase slug")
    require(text_value(batch["title"]), "batch title must not be blank")
    try:
        require(isinstance(batch["project_id"], str), "project_id must be a UUID")
        require(str(UUID(batch["project_id"])) == batch["project_id"],
                "project_id must be a canonical UUID")
    except (ValueError, AttributeError) as exc:
        raise BatchError("project_id must be a canonical UUID") from exc
    require(type(batch["max_parallel"]) is int and batch["max_parallel"] > 0,
            "max_parallel must be a positive integer")
    require(isinstance(batch["tasks"], list) and batch["tasks"], "tasks must not be empty")
    task_fields = {"id", "title", "description", "acceptance", "depends_on", "resources"}
    tasks = {}
    for task in batch["tasks"]:
        require(isinstance(task, dict) and set(task) == task_fields,
                "each task must contain exactly: " + ", ".join(sorted(task_fields)))
        key = task["id"]
        require(isinstance(key, str) and SLUG.fullmatch(key), "task id must be a lowercase slug")
        require(key not in tasks, f"duplicate task id: {key}")
        require(text_value(task["title"]) and text_value(task["description"]),
                f"{key}: title and description must not be blank")
        for field in ("acceptance", "depends_on", "resources"):
            string_list(task[field], f"{key}.{field}", nonempty=field == "acceptance")
        tasks[key] = task
    visited, visiting = set(), set()

    def visit(key):
        require(key in tasks, f"unknown dependency: {key}")
        require(key not in visiting, f"dependency cycle at: {key}")
        if key in visited:
            return
        visiting.add(key)
        for dependency in tasks[key]["depends_on"]:
            visit(dependency)
        visiting.remove(key)
        visited.add(key)

    for key in tasks:
        visit(key)
    return batch


def marker(batch, key):
    return f"[pr-cycle:{batch['batch_id']}:{key}]"


def digest(value):
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def cards(batch):
    result = {}
    for key, task in [(PARENT, None)] + [(t["id"], t) for t in batch["tasks"]]:
        definition = batch if task is None else {"project_id": batch["project_id"], "task": task}
        header = marker(batch, key) + "\n[manifest-sha256:" + digest(definition) + "]\n[dispatch:ready]"
        if task is None:
            title = f"[{batch['batch_id']}] {batch['title']}"
            body = (f"批次协调卡；不要作为实现任务启动。并发上限：{batch['max_parallel']}。\n"
                    "子卡为逻辑关联，不使用原生父子字段：\n" +
                    "\n".join(f"- {t['id']}: {t['title']}" for t in batch["tasks"]))
        else:
            title = f"[{batch['batch_id']}/{key}] {task['title']}"
            body = (task["description"] + "\n\n验收条件：\n" +
                    "\n".join(f"- {x}" for x in task["acceptance"]) +
                    f"\n\n依赖：{', '.join(task['depends_on']) or '无'}\n"
                    f"独占资源：{', '.join(task['resources']) or '无'}\n"
                    f"批次卡：{marker(batch, PARENT)}\n"
                    "工作者须读取 pr-cycle 与 task-contract；实际运行自证后交协调者。\n"
                    "不要自行派生任务、启动其他工作者或合并 PR。")
        body += ("\n\n阶段：queued\n轮次：0/3\n负责人：待分配\n"
                 "单 PR 计划 / P0～P3 等级 / 定级依据 / 审批要求：协调者核对任务描述后补齐\n"
                 "PR / worktree / base SHA / head SHA：待记录\n"
                 "自证 / 独立审查者 / 功能与代码质量 / 安全 / 组合验证证据：待记录\n"
                 "人工批准者 / 对应方案或 SHA / 批准证据 / 合并状态 / 复盘记录：待记录\n"
                 "阻塞原因与恢复动作：无\n"
                 "派发前核实分级门槛；P0 未获用户方案批准时设为 hold，不启动实现。\n"
                 "第三轮未通过即停止自动返工转人工；P3 自动化止于创建 PR，不自动合并。\n"
                 "按 references/workflow.md 推进；看板状态不替代验收证据。\n")
        result[key] = {"project_id": batch["project_id"], "title": title,
                       "description": header + "\n\n" + body, "status": "todo"}
    return result


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BatchError("API redirect refused")


class Client:
    def __init__(self, url, timeout=15):
        try:
            parts = parse.urlsplit(url)
            host = parts.hostname
            if host == "localhost":
                host = "127.0.0.1"
            require(parts.scheme == "http" and ipaddress.ip_address(host).is_loopback,
                    "URL must use HTTP on a literal loopback address or localhost")
            require(not parts.username and not parts.password and not parts.query
                    and not parts.fragment and parts.path in ("", "/"),
                    "URL must have no credentials, query, fragment or path")
            host = f"[{host}]" if ":" in host else host
            self.url = f"http://{host}:{parts.port or 80}"
        except (ValueError, TypeError) as exc:
            raise BatchError("invalid local API URL") from exc
        self.timeout = timeout
        self.opener = request.build_opener(request.ProxyHandler({}), NoRedirect())

    def call(self, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        req = request.Request(self.url + path, data=data, headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=self.timeout) as response:
                result = json.load(response)
        except (OSError, error.URLError, ValueError) as exc:
            suffix = " POST outcome unknown; read the board before rerunning; no automatic retry." if data else ""
            raise BatchError("local API request failed." + suffix) from exc
        require(isinstance(result, dict) and result.get("success") is True and "data" in result,
                "API did not return a successful Vibe Kanban response")
        return result["data"]


def primary_identity(header):
    """Recognize a complete header's identity syntax, not its manifest authenticity."""
    if len(header) < 3:
        return None
    identity = re.fullmatch(r"\[pr-cycle:([^:\]]+):([^:\]]+)\]", header[0])
    if not identity or not SLUG.fullmatch(identity[1]):
        return None
    if identity[2] != PARENT and not SLUG.fullmatch(identity[2]):
        return None
    if (not re.fullmatch(r"\[manifest-sha256:[0-9a-f]{64}\]", header[1])
            or header[2] not in {"[dispatch:ready]", "[dispatch:hold]"}):
        return None
    return identity.groups()


def index_cards(batch, rows, expected):
    require(isinstance(rows, list), "task API must return a list")
    indexed = {}
    prefix = f"[pr-cycle:{batch['batch_id']}:"
    title_identity = re.compile(r"\[" + re.escape(batch["batch_id"]) + r"(?:\]|/[a-z0-9][a-z0-9_-]{0,63}\])")
    for row in rows:
        require(isinstance(row, dict), "malformed task API response")
        description = row.get("description") or ""
        require(isinstance(description, str), "malformed task description")
        header = description.splitlines()
        if not description.startswith(prefix):
            title = row.get("title") or ""
            require(isinstance(title, str), "malformed task title")
            identity = primary_identity(header)
            if identity is not None and identity[0] != batch["batch_id"]:
                # An explicit foreign identity makes body mentions references.
                # A conflicting leading title still needs reconciliation.
                require(not title_identity.match(title.lstrip()),
                        f"conflicting batch identity on board card {row.get('id', '<unknown>')}; "
                        "reconcile its original marker before importing or dispatching")
                continue
            # A displaced marker or reserved title is evidence of a damaged
            # identity, never permission to create a replacement task.
            require(prefix not in description and not title_identity.search(title),
                    f"damaged batch identity on board card {row.get('id', '<unknown>')}; "
                    "reconcile its original marker before importing or dispatching")
            continue
        key = header[0][len(prefix):-1] if header[0].endswith("]") else ""
        require(key in expected, "unknown card in batch: " + key)
        require(key not in indexed, "duplicate board marker: " + key)
        require(header[:2] == expected[key]["description"].splitlines()[:2],
                "manifest changed or header damaged for: " + key + "; reconcile explicitly or use a new batch_id")
        require(len(header) >= 3 and header[2] in {"[dispatch:ready]", "[dispatch:hold]"},
                "missing or invalid dispatch marker: " + key)
        require(row.get("project_id") == batch["project_id"] and text_value(row.get("id")),
                "card identity mismatch: " + key)
        require(row.get("status") in STATUSES, "unknown board status: " + key)
        indexed[key] = row
    return indexed


def read_board(batch, client, expected):
    info = client.call("/api/info")
    require(isinstance(info, dict) and isinstance(info.get("config"), dict)
            and info["config"].get("last_app_version") == VERSION,
            "board version must be " + VERSION + "; do not use latest or migrate this adapter implicitly")
    project = client.call("/api/projects/" + batch["project_id"])
    require(isinstance(project, dict) and project.get("id") == batch["project_id"],
            "project was not found")
    return index_cards(batch, client.call("/api/tasks?" + parse.urlencode({"project_id": batch["project_id"]})), expected)


@contextmanager
def import_lock(batch, client):
    path = Path(tempfile.gettempdir()) / ("pr-cycle-" + digest([client.url, batch["project_id"], batch["batch_id"]]) + ".lock")
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise BatchError(f"batch import locked: {path}; verify the previous importer stopped before removing it") from exc
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(str(os.getpid()))
        yield
    finally:
        path.unlink()


def import_batch(batch, client, apply=False):
    expected = cards(batch)
    with import_lock(batch, client):
        existing = read_board(batch, client, expected)
        actions = []
        for key, payload in expected.items():
            row = existing.get(key)
            action = "existing" if row else "create"
            if row is None and apply:
                row = client.call("/api/tasks", payload)
                require(isinstance(row, dict) and text_value(row.get("id")),
                        "POST returned no task ID; inspect board before retrying")
            actions.append({"task": key, "action": action, "board_id": row["id"] if row else None})
    return {"batch_id": batch["batch_id"], "applied": apply, "cards": actions}


def ready(batch, client):
    existing = read_board(batch, client, cards(batch))
    require(len(existing) == len(batch["tasks"]) + 1, "batch cards are missing; import/reconcile first")
    require(existing[PARENT]["status"] not in {"done", "cancelled"}, "batch is closed")
    tasks = {task["id"]: task for task in batch["tasks"]}
    held = {key for key, row in existing.items()
            if row["description"].splitlines()[2] == "[dispatch:hold]"}
    # Terminal + ready records the coordinator's reconciliation, not a PID check.
    active = {key for key in tasks if existing[key]["status"] in {"inprogress", "inreview"}
              or existing[key].get("has_in_progress_attempt")
              or (existing[key].get("last_attempt_failed")
                  and (existing[key]["status"] not in {"done", "cancelled"} or key in held))}
    paused = PARENT in held
    occupied = {resource for key in active for resource in tasks[key]["resources"]}
    slots = max(0, batch["max_parallel"] - len(active))
    selected, blocked = [], {}
    for key, task in tasks.items():
        row = existing[key]
        if paused:
            blocked[key] = "batch paused"
        elif key in held:
            blocked[key] = "dispatch held by coordinator"
        elif key in active or row["status"] != "todo":
            blocked[key] = "active, failed, or not todo; coordinator must reconcile"
        elif any(existing[d]["status"] != "done" or d in active or d in held
                 for d in task["depends_on"]):
            blocked[key] = "dependency not closed"
        elif occupied.intersection(task["resources"]):
            blocked[key] = "resource occupied"
        elif len(selected) >= slots:
            blocked[key] = "WIP limit"
        else:
            selected.append({"task": key, "board_id": row["id"]})
            occupied.update(task["resources"])
    return {"batch_id": batch["batch_id"], "active": sorted(active), "ready": selected,
            "blocked": blocked, "paused": paused, "advisory_only": True,
            "note": "Coordinator must verify evidence, live attempts and global resource/WIP limits before starting."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("validate", "import", "ready"):
        command = commands.add_parser(name)
        command.add_argument("batch", type=Path)
        if name != "validate":
            command.add_argument("--url", default="http://127.0.0.1:13680")
        if name == "import":
            command.add_argument("--apply", action="store_true", help="create missing cards; default is read-only preview")
    args = parser.parse_args()
    try:
        batch = validate(json.loads(args.batch.read_text(encoding="utf-8-sig")))
        if args.command == "validate":
            result = {"valid": True, "batch_id": batch["batch_id"], "tasks": len(batch["tasks"])}
        elif args.command == "import":
            result = import_batch(batch, Client(args.url), args.apply)
        else:
            result = ready(batch, Client(args.url))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (BatchError, OSError, json.JSONDecodeError, RecursionError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
