"""Integration tests for the pinned, unmodified official Ralph hooks (no AI calls).

Run setup-claude-runtime.ps1 first. Missing optional runtime is explicitly skipped.
PR_CYCLE_RUNTIME and CLAUDE_CODE_GIT_BASH_PATH can override local runtime paths.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = Path(os.environ.get("PR_CYCLE_RUNTIME", ROOT / ".pr-cycle-runtime"))
PLUGIN = RUNTIME / "claude-plugins-official" / "plugins" / "ralph-loop"


def find_bash():
    explicit = os.environ.get("CLAUDE_CODE_GIT_BASH_PATH")
    if explicit:
        return explicit
    if os.name != "nt":
        return shutil.which("bash")
    git = shutil.which("git")
    if git:
        candidate = Path(git).resolve().parents[1] / "bin" / "bash.exe"
        if candidate.is_file():
            return str(candidate)
    return None  # Never fall back to the Windows WSL bash launcher.


class OfficialRalphHookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bash = find_bash()
        if not cls.bash or not (PLUGIN / "hooks" / "stop-hook.sh").is_file():
            raise unittest.SkipTest("Install optional Claude runtime to run official hook integration tests")
        cls.env = dict(os.environ)
        bash_bin = Path(cls.bash).resolve().parent
        cls.env["PATH"] = os.pathsep.join(
            [str(RUNTIME / "bin"), str(bash_bin), str(bash_bin.parent / "usr" / "bin"), cls.env["PATH"]]
        )
        cls.env["CLAUDE_CODE_SESSION_ID"] = "pr-cycle-test-session"
        cls.env["CLAUDE_PLUGIN_ROOT"] = PLUGIN.as_posix()
        check = subprocess.run([cls.bash, "-c", "jq --version && perl -e 'exit 0'"],
                               env=cls.env, capture_output=True, timeout=15)
        if check.returncode:
            raise RuntimeError("Runtime exists but jq/perl preflight failed: " + check.stderr.decode(errors="replace"))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pr-cycle-hook-中文-")
        self.addCleanup(self.temp.cleanup)
        self.cwd = Path(self.temp.name)
        self.state = self.cwd / ".claude" / "ralph-loop.local.md"
        self.transcript = self.cwd / "transcript.jsonl"

    def run_script(self, relative, *args, stdin=None):
        result = subprocess.run(
            [self.bash, (PLUGIN / relative).as_posix(), *args],
            cwd=self.cwd, env=self.env, input=stdin, capture_output=True,
            encoding="utf-8", timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def start(self, limit=3):
        self.run_script("scripts/setup-ralph-loop.sh", "Continue the test task safely.",
                        "--max-iterations", str(limit), "--completion-promise", "PR_CYCLE_HANDOFF")
        self.assertTrue(self.state.exists())

    def stop(self, text="Still working", session="pr-cycle-test-session", trailing_tool=False):
        messages = [{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}]
        if trailing_tool:
            messages.append({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "test", "name": "Read", "input": {}}]}})
        self.transcript.write_text("\n".join(json.dumps(m, separators=(",", ":")) for m in messages) + "\n", encoding="utf-8")
        return self.run_script("hooks/stop-hook.sh", stdin=json.dumps({
            "session_id": session, "transcript_path": self.transcript.as_posix(),
        }))

    def test_no_state_allows_stop(self):
        self.assertEqual(self.stop().stdout.strip(), "")
        self.assertFalse(self.state.exists())

    def test_continue_blocks_and_increments(self):
        self.start()
        result = json.loads(self.stop().stdout)
        self.assertEqual(result["decision"], "block")
        self.assertEqual(result["reason"].strip(), "Continue the test task safely.")
        self.assertIn("iteration: 2", self.state.read_text(encoding="utf-8"))

    def test_matching_handoff_stops(self):
        self.start()
        self.stop("Evidence recorded. <promise>PR_CYCLE_HANDOFF</promise>")
        self.assertFalse(self.state.exists())

    def test_wrong_promise_continues(self):
        self.start()
        self.assertEqual(json.loads(self.stop("<promise>NOT_READY</promise>").stdout)["decision"], "block")
        self.assertTrue(self.state.exists())

    def test_iteration_limit_stops_without_claiming_completion(self):
        self.start(limit=2)
        self.stop()
        result = self.stop()
        self.assertIn("Max iterations (2) reached", result.stdout)
        self.assertFalse(self.state.exists())
        self.assertNotIn("Detected <promise>", result.stdout)

    def test_foreign_session_preserves_state(self):
        self.start()
        before = self.state.read_bytes()
        self.assertEqual(self.stop(session="other-session").stdout.strip(), "")
        self.assertEqual(self.state.read_bytes(), before)

    def test_trailing_tool_block_does_not_hide_last_text(self):
        self.start()
        self.stop("<promise>PR_CYCLE_HANDOFF</promise>", trailing_tool=True)
        self.assertFalse(self.state.exists())


if __name__ == "__main__":
    unittest.main()
