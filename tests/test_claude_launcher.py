"""Windows integration checks; no model calls or workers are started.

Requires setup-claude-runtime.ps1 and an installed Claude Code CLI.
The board is a loopback-only test server, not the user's real board.
PR_CYCLE_RUNTIME can point to an existing pinned runtime.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/pr-cycle/scripts/start-claude-cycle.ps1"
RUNTIME = Path(os.environ.get("PR_CYCLE_RUNTIME", ROOT / ".pr-cycle-runtime"))


@unittest.skipUnless(
    os.name == "nt" and shutil.which("claude.cmd") and (RUNTIME / "bin/jq.exe").is_file(),
    "requires Windows, Claude Code, and the bootstrapped runtime",
)
class ClaudeLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pr-cycle-launcher-")
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name)
        self.approvals = {"approvals": True}
        self.version = "0.0.166"
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/api/projects":
                    data = []
                elif self.path == "/api/info":
                    data = {"config": {"last_app_version": owner.version}}
                elif self.path == "/api/profiles":
                    data = {"content": json.dumps({"executors": {"CLAUDE_CODE": {
                        "APPROVALS": {"CLAUDE_CODE": owner.approvals}
                    }}})}
                else:
                    self.send_error(404)
                    return
                body = json.dumps({"success": True, "data": data}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def check(self):
        return subprocess.run(
            ["powershell", "-NoProfile", "-File", str(SCRIPT), "-CheckOnly",
             "-ProjectPath", str(self.project), "-RuntimePath", str(RUNTIME),
             "-Port", str(self.server.server_port)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
        )

    def test_check_only_validates_without_creating_project_state(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Checks passed", result.stdout)
        self.assertEqual(list(self.project.iterdir()), [])

    def test_existing_state_is_preserved_and_refused(self):
        state = self.project / ".claude/ralph-loop.local.md"
        state.parent.mkdir()
        state.write_text("existing coordinator state", encoding="utf-8")
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("existing Ralph state", result.stderr)
        self.assertEqual(state.read_text(encoding="utf-8"), "existing coordinator state")

    def test_unsafe_worker_profile_is_refused(self):
        self.approvals["dangerously_skip_permissions"] = True
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("APPROVALS must enable approvals", result.stderr)

    def test_incompatible_board_version_is_refused(self):
        self.version = "99.0.0"
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("reported version does not match", result.stderr)


if __name__ == "__main__":
    unittest.main()
