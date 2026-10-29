"""Behavior checks against an isolated HTTP board, without starting coding agents."""

from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import socket
import threading
import unittest
from uuid import uuid4


SCRIPT = Path(__file__).resolve().parents[1] / "skills/pr-cycle/scripts/kanban_batch.py"
SPEC = importlib.util.spec_from_file_location("kanban_batch", SCRIPT)
kb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kb)


def batch():
    return {
        "schema_version": 1, "batch_id": "test", "title": "Test batch",
        "project_id": "12345678-1234-1234-1234-123456789abc", "max_parallel": 2,
        "tasks": [
            {"id": key, "title": key.upper(), "description": "Implement " + key,
             "acceptance": ["Observable result"], "depends_on": [], "resources": []}
            for key in ["a", "b", "c"]
        ],
    }


class Board:
    def __init__(self):
        self.rows = []
        self.posts = 0
        self.drop_post = False
        self.redirect = False
        self.version = "0.0.166"
        self.data = batch()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, data):
                body = json.dumps({"success": True, "data": data}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if owner.redirect:
                    self.send_response(302)
                    self.send_header("Location", "http://example.com/")
                    self.end_headers()
                elif self.path == "/api/info":
                    self.respond({"config": {"last_app_version": owner.version}})
                elif self.path.startswith("/api/projects/"):
                    self.respond({"id": owner.data["project_id"]})
                elif self.path.startswith("/api/tasks?"):
                    self.respond(owner.rows)
                else:
                    self.send_error(404)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                row = {**body, "id": str(uuid4()), "has_in_progress_attempt": False,
                       "last_attempt_failed": False}
                owner.rows.append(row)
                owner.posts += 1
                if owner.drop_post:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                else:
                    self.respond(row)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = kb.Client(f"http://127.0.0.1:{self.server.server_port}", timeout=1)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def row(self, key):
        return next(row for row in self.rows if row["description"].startswith(kb.marker(self.data, key) + "\n"))

    def seed(self):
        kb.import_batch(self.data, self.client, apply=True)


class ValidationTests(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(kb.validate(batch())["max_parallel"], 2)

    def test_invalid_definitions(self):
        cases = []
        for field, value in [("max_parallel", True), ("max_parallel", 0), ("project_id", ""),
                             ("schema_version", True), ("title", " "), ("tasks", [])]:
            data = batch()
            data[field] = value
            cases.append(data)
        data = batch()
        data["unknown"] = 1
        cases.append(data)
        for field, value in [("id", "a"), ("acceptance", []), ("resources", [1]),
                             ("depends_on", ["missing"]), ("description", "")]:
            data = batch()
            data["tasks"][1][field] = value
            cases.append(data)
        data = batch()
        data["tasks"][0]["depends_on"] = ["b"]
        data["tasks"][1]["depends_on"] = ["a"]
        cases.append(data)
        for data in cases:
            with self.subTest(data=data), self.assertRaises(kb.BatchError):
                kb.validate(data)

    def test_external_and_credential_urls_are_rejected(self):
        for url in ["https://example.com", "http://example.com", "http://127.0.0.1@evil.test",
                    "http://u:p@127.0.0.1", "http://127.0.0.1/api", "http://127.0.0.1?q=x"]:
            with self.subTest(url=url), self.assertRaises(kb.BatchError):
                kb.Client(url)


class BoardTests(unittest.TestCase):
    def setUp(self):
        self.board = Board()
        self.addCleanup(self.board.close)

    def test_preview_is_read_only_and_import_is_idempotent(self):
        preview = kb.import_batch(self.board.data, self.board.client)
        self.assertEqual(self.board.posts, 0)
        self.assertTrue(all(card["board_id"] is None for card in preview["cards"]))
        self.board.seed()
        self.board.row("a")["status"] = "inreview"
        self.board.row("a")["description"] += "\nReviewer evidence"
        repeated = kb.import_batch(self.board.data, self.board.client, apply=True)
        self.assertEqual(self.board.posts, 4)
        self.assertTrue(all(card["action"] == "existing" for card in repeated["cards"]))
        self.assertEqual(self.board.row("a")["status"], "inreview")

    def test_duplicate_or_changed_manifest_refuses_mutation(self):
        self.board.seed()
        changed = deepcopy(self.board.data)
        changed["tasks"][0]["title"] = "Different contract"
        with self.assertRaises(kb.BatchError):
            kb.import_batch(changed, self.board.client, True)
        self.board.rows.append(deepcopy(self.board.row("a")))
        with self.assertRaises(kb.BatchError):
            kb.import_batch(self.board.data, self.board.client, True)
        self.assertEqual(self.board.posts, 4)

    def assert_identity_damage_stops_all_commands(self, row):
        before = deepcopy(self.board.rows)
        posts = self.board.posts
        for command in (
            lambda: kb.import_batch(self.board.data, self.board.client),
            lambda: kb.import_batch(self.board.data, self.board.client, True),
            lambda: kb.ready(self.board.data, self.board.client),
        ):
            with self.assertRaisesRegex(kb.BatchError, row["id"]):
                command()
            self.assertEqual(self.board.posts, posts)
            self.assertEqual(self.board.rows, before)

    def test_displaced_identity_stops_import_and_ready(self):
        self.board.seed()
        for key in (kb.PARENT, "a"):
            row = self.board.row(key)
            original = deepcopy(row)
            for prefix in ("\n", "Coordinator note\n", " \t"):
                with self.subTest(key=key, prefix=prefix):
                    row.update(original)
                    row["title"] = "Renamed card without a title identity"
                    row["description"] = prefix + original["description"]
                    row["status"] = "inprogress"
                    row["has_in_progress_attempt"] = True
                    self.assert_identity_damage_stops_all_commands(row)
            row.update(original)

    def test_missing_identity_with_reserved_title_stops_all_commands(self):
        self.board.seed()
        for key in (kb.PARENT, "a"):
            row = self.board.row(key)
            original = deepcopy(row)
            for description in (original["description"].split("\n", 1)[1], "", None):
                with self.subTest(key=key, description=description):
                    row.update(original)
                    row["title"] = "\nCoordinator note: " + original["title"]
                    row["description"] = description
                    row["status"] = "inprogress"
                    row["has_in_progress_attempt"] = True
                    self.assert_identity_damage_stops_all_commands(row)
            row.update(original)

    def test_restored_identity_reuses_id_and_counts_running_task(self):
        self.board.seed()
        row = self.board.row("a")
        original_description = row["description"]
        row["status"] = "inprogress"
        row["has_in_progress_attempt"] = True
        row["description"] = "Coordinator note\n" + original_description
        self.assert_identity_damage_stops_all_commands(row)
        row["description"] = original_description + "\nCoordinator note"
        result = kb.import_batch(self.board.data, self.board.client, True)
        self.assertEqual(self.board.posts, 4)
        restored = next(card for card in result["cards"] if card["task"] == "a")
        self.assertEqual(restored["action"], "existing")
        self.assertEqual(restored["board_id"], row["id"])
        result = kb.ready(self.board.data, self.board.client)
        self.assertEqual(result["active"], ["a"])
        self.assertEqual([card["task"] for card in result["ready"]], ["b"])

    def test_unrelated_and_similarly_named_batches_are_ignored(self):
        self.board.seed()
        for batch_id in ("tes", "test-extra", "testing"):
            other = deepcopy(self.board.data)
            other["batch_id"] = batch_id
            for payload in kb.cards(other).values():
                self.board.rows.append({**payload, "id": str(uuid4())})
        self.board.rows.append({"id": str(uuid4()), "title": "Ordinary task", "description": None})
        result = kb.import_batch(self.board.data, self.board.client, True)
        self.assertTrue(all(card["action"] == "existing" for card in result["cards"]))
        self.assertEqual(self.board.posts, 4)
        self.assertEqual([card["task"] for card in kb.ready(self.board.data, self.board.client)["ready"]], ["a", "b"])

    def test_valid_batches_can_reference_each_other_without_changing_identity(self):
        self.board.seed()
        other = deepcopy(self.board.data)
        other["batch_id"] = "followup"
        other["tasks"][0]["description"] += "\nRelated: " + kb.marker(self.board.data, "a")
        kb.import_batch(other, self.board.client, True)
        original_ids = {row["id"] for row in self.board.rows}
        for data, referenced in ((self.board.data, other), (other, self.board.data)):
            for key in (kb.PARENT, "a"):
                row = next(row for row in self.board.rows
                           if row["description"].startswith(kb.marker(data, key) + "\n"))
                row["description"] += "\nRelated: " + kb.marker(referenced, key)
                row["description"] += "\n" + kb.marker(referenced, key)
                row["title"] += " (related [" + referenced["batch_id"] + "/a])"
                if key == "a":
                    row["status"] = "inprogress"
                    row["has_in_progress_attempt"] = True
        before = deepcopy(self.board.rows)
        for data in (self.board.data, other):
            with self.subTest(batch_id=data["batch_id"]):
                for apply in (False, True):
                    result = kb.import_batch(data, self.board.client, apply)
                    self.assertTrue(all(card["action"] == "existing" for card in result["cards"]))
                result = kb.ready(data, self.board.client)
                self.assertEqual(result["active"], ["a"])
                self.assertEqual([card["task"] for card in result["ready"]], ["b"])
        self.assertEqual(self.board.posts, 8)
        self.assertEqual({row["id"] for row in self.board.rows}, original_ids)
        self.assertEqual(self.board.rows, before)

    def test_malformed_foreign_header_does_not_hide_displaced_identity(self):
        self.board.seed()
        row = self.board.row("a")
        original = deepcopy(row)
        for foreign_header in (
            "[pr-cycle:followup:a]\n",
            "[pr-cycle:followup:a]\n[manifest-sha256:invalid]\n[dispatch:ready]\n",
            "[pr-cycle:followup:a]\n[manifest-sha256:" + "0" * 64 + "]\n[dispatch:invalid]\n",
        ):
            with self.subTest(foreign_header=foreign_header):
                row.update(original)
                row["title"] = "Renamed card"
                row["description"] = foreign_header + original["description"]
                self.assert_identity_damage_stops_all_commands(row)

    def test_foreign_header_conflicting_with_own_title_stops_all_commands(self):
        self.board.seed()
        for key in (kb.PARENT, "a"):
            row = self.board.row(key)
            original = deepcopy(row)
            row["description"] = row["description"].replace(
                kb.marker(self.board.data, key), "[pr-cycle:followup:" + key + "]", 1)
            self.assert_identity_damage_stops_all_commands(row)
            row.update(original)

    def test_post_connection_loss_does_not_retry_and_recovers_from_board(self):
        self.board.drop_post = True
        with self.assertRaisesRegex(kb.BatchError, "outcome unknown"):
            self.board.seed()
        self.assertEqual(self.board.posts, 1)
        self.board.drop_post = False
        self.board.seed()
        self.assertEqual(self.board.posts, 4)

    def test_redirect_refused(self):
        self.board.redirect = True
        with self.assertRaises(kb.BatchError):
            self.board.seed()
        self.assertEqual(self.board.posts, 0)

    def test_wrong_version_refuses_writes(self):
        self.board.version = "0.1.44"
        with self.assertRaisesRegex(kb.BatchError, "version must be"):
            self.board.seed()
        self.assertEqual(self.board.posts, 0)

    def test_lock_rejects_second_importer(self):
        with kb.import_lock(self.board.data, self.board.client):
            with self.assertRaisesRegex(kb.BatchError, "locked"):
                self.board.seed()
        self.assertEqual(self.board.posts, 0)

    def test_wip_limit_counts_review_and_running_attempts(self):
        self.board.seed()
        result = kb.ready(self.board.data, self.board.client)
        self.assertEqual([x["task"] for x in result["ready"]], ["a", "b"])
        self.board.row("a")["status"] = "inreview"
        self.board.row("b")["has_in_progress_attempt"] = True
        result = kb.ready(self.board.data, self.board.client)
        self.assertEqual(result["ready"], [])
        self.assertEqual(result["active"], ["a", "b"])

    def test_resource_conflicts_are_excluded_from_same_wave(self):
        self.board.data["tasks"][0]["resources"] = ["db"]
        self.board.data["tasks"][1]["resources"] = ["db"]
        self.board.seed()
        result = kb.ready(self.board.data, self.board.client)
        self.assertEqual([x["task"] for x in result["ready"]], ["a", "c"])
        self.assertEqual(result["blocked"]["b"], "resource occupied")

    def test_dependencies_wait_for_done_without_hold_or_running_attempt(self):
        self.board.data["tasks"][1]["depends_on"] = ["a"]
        self.board.seed()
        self.assertNotIn("b", [x["task"] for x in kb.ready(self.board.data, self.board.client)["ready"]])
        self.board.row("a")["status"] = "done"
        self.board.row("a")["has_in_progress_attempt"] = True
        self.assertEqual(kb.ready(self.board.data, self.board.client)["blocked"]["b"], "dependency not closed")
        self.board.row("a")["has_in_progress_attempt"] = False
        self.board.row("a")["last_attempt_failed"] = True
        self.board.row("a")["description"] = self.board.row("a")["description"].replace(
            "[dispatch:ready]", "[dispatch:hold]", 1)
        self.assertEqual(kb.ready(self.board.data, self.board.client)["blocked"]["b"], "dependency not closed")
        self.board.row("a")["description"] = self.board.row("a")["description"].replace(
            "[dispatch:hold]", "[dispatch:ready]", 1)
        self.assertIn("b", [x["task"] for x in kb.ready(self.board.data, self.board.client)["ready"]])

    def test_done_dependency_on_hold_blocks_without_failed_attempt(self):
        self.board.data["tasks"][1]["depends_on"] = ["a"]
        self.board.seed()
        a = self.board.row("a")
        a["status"] = "done"
        a["description"] = a["description"].replace("[dispatch:ready]", "[dispatch:hold]", 1)
        result = kb.ready(self.board.data, self.board.client)
        self.assertEqual(result["blocked"]["b"], "dependency not closed")

    def test_reconciled_terminal_tasks_release_historical_failure_slots(self):
        self.board.seed()
        a = self.board.row("a")
        a["last_attempt_failed"] = True
        for status in ["done", "cancelled"]:
            with self.subTest(status=status):
                a["status"] = status
                result = kb.ready(self.board.data, self.board.client)
                self.assertEqual(result["active"], [])
                self.assertEqual([x["task"] for x in result["ready"]], ["b", "c"])
                a["description"] = a["description"].replace("[dispatch:ready]", "[dispatch:hold]", 1)
                self.assertEqual(kb.ready(self.board.data, self.board.client)["active"], ["a"])
                a["description"] = a["description"].replace("[dispatch:hold]", "[dispatch:ready]", 1)
                a["has_in_progress_attempt"] = True
                self.assertEqual(kb.ready(self.board.data, self.board.client)["active"], ["a"])
                a["has_in_progress_attempt"] = False

    def test_failed_todo_is_not_restarted(self):
        self.board.seed()
        self.board.row("a")["last_attempt_failed"] = True
        result = kb.ready(self.board.data, self.board.client)
        self.assertEqual([x["task"] for x in result["ready"]], ["b"])
        self.assertEqual(result["active"], ["a"])

    def test_missing_or_unknown_cards_fail_closed(self):
        self.board.seed()
        self.board.rows.remove(self.board.row("a"))
        with self.assertRaises(kb.BatchError):
            kb.ready(self.board.data, self.board.client)
        unknown = deepcopy(self.board.row("b"))
        unknown["description"] = unknown["description"].replace(":b]", ":unexpected]", 1)
        self.board.rows.append(unknown)
        with self.assertRaises(kb.BatchError):
            kb.ready(self.board.data, self.board.client)

    def test_closed_batch_is_not_dispatched(self):
        self.board.seed()
        self.board.row(kb.PARENT)["status"] = "cancelled"
        with self.assertRaises(kb.BatchError):
            kb.ready(self.board.data, self.board.client)

    def test_hold_and_resume_preserve_identity_and_active_slots(self):
        self.board.seed()
        a = self.board.row("a")
        a["description"] = a["description"].replace("[dispatch:ready]", "[dispatch:hold]", 1)
        result = kb.ready(self.board.data, self.board.client)
        self.assertEqual([x["task"] for x in result["ready"]], ["b", "c"])
        a["status"] = "inprogress"
        result = kb.ready(self.board.data, self.board.client)
        self.assertEqual([x["task"] for x in result["ready"]], ["b"])
        self.assertEqual(result["active"], ["a"])
        parent = self.board.row(kb.PARENT)
        parent["description"] = parent["description"].replace("[dispatch:ready]", "[dispatch:hold]", 1)
        result = kb.ready(self.board.data, self.board.client)
        self.assertTrue(result["paused"])
        self.assertEqual(result["ready"], [])
        self.assertEqual(result["active"], ["a"])
        kb.import_batch(self.board.data, self.board.client, True)
        self.assertEqual(self.board.posts, 4)
        parent["description"] = parent["description"].replace("[dispatch:hold]", "[dispatch:ready]", 1)
        self.assertFalse(kb.ready(self.board.data, self.board.client)["paused"])

    def test_missing_dispatch_marker_fails_closed(self):
        self.board.seed()
        row = self.board.row("a")
        row["description"] = row["description"].replace("[dispatch:ready]", "", 1)
        with self.assertRaisesRegex(kb.BatchError, "dispatch marker"):
            kb.ready(self.board.data, self.board.client)


if __name__ == "__main__":
    unittest.main()
