"""Configure pinned Kanban built-in presets to use installed CLIs (no downloads).

Called by start-kanban.ps1 on each start. --check previews the change. Custom
commands, presets, environment variables and permission settings are preserved.
"""

import argparse
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import shutil
import subprocess
import urllib.request

from use_local_codex_config import MODEL_FIELDS, VARIANTS
from codex_config_compat import adapt_codex_config

ROOT = Path(__file__).resolve().parents[3]
BRIDGE = Path(__file__).with_name("codex-local-bridge.mjs")
LAUNCHER = Path(__file__).with_name("local-cli.mjs")
PRESETS = {"CODEX": VARIANTS, "CLAUDE_CODE": ("DEFAULT", "PLAN", "OPUS", "APPROVALS")}
MANAGED_COMMAND = "PR_CYCLE_LOCAL_CLI_COMMAND"


def discover_cli(name, explicit=None):
    env = os.environ.copy()
    if explicit:
        env[f"PR_CYCLE_{name.upper()}_PATH"] = str(Path(explicit).resolve())
    result = probe_clis(name, env)[name]
    if not result['available']:
        raise RuntimeError(result['error'])
    return Path(result['source']), result['version']


def probe_clis(name=None, env=None):
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required for local CLI adapters")
    args = [node, str(LAUNCHER), "--probe"] + ([name] if name else [])
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                            timeout=40, check=True, env=env)
    return json.loads(result.stdout)


def command_line(args):
    args = [str(arg) for arg in args]
    return subprocess.list2cmdline(args) if os.name == "nt" else shlex.join(args)


def is_legacy_binding(command, executor):
    """Recognize only the old generated adapter command, never a substring."""
    try:
        parts = shlex.split(command or "", posix=os.name != "nt")
    except ValueError:
        return False
    if os.name == "nt":
        parts = [part.removeprefix('"').removesuffix('"') for part in parts]
    parts = [part.replace("\\", "/") for part in parts]
    if len(parts) < 2 or PurePosixPath(parts[0]).name not in ("node", "node.exe"):
        return False
    if executor == "CODEX":
        return parts[1].endswith("/skills/pr-cycle/scripts/codex-local-bridge.mjs") and (
            len(parts) == 2 or (len(parts) == 4 and parts[2] == "--cli")
        )
    return (len(parts) == 3 and parts[2] == "claude"
            and parts[1].endswith("/skills/pr-cycle/scripts/local-cli.mjs"))


def update_profiles(original, commands, legacy_commands=None):
    updated = copy.deepcopy(original)
    changed, skipped = [], []
    for executor, command in commands.items():
        for name in PRESETS[executor]:
            config = updated.get("executors", {}).get(executor, {}).get(name, {}).get(executor)
            if config is None:
                continue
            previous = config.get("base_command_override")
            env = config.get("env") or {}
            recorded = env.get(MANAGED_COMMAND)
            # A marker alone does not establish ownership after a UI edit.
            managed = (previous == recorded if recorded is not None
                       else is_legacy_binding(previous, executor))
            legacy = (legacy_commands or {}).get(executor)
            if previous and not managed and (recorded is not None or
                                             (previous != command and previous != legacy)):
                skipped.append(f"{executor}/{name}: existing custom command")
                continue
            config["base_command_override"] = command
            config["env"] = {**env, "PR_CYCLE_LOCAL_CLI": "1", MANAGED_COMMAND: command}
            if executor == "CODEX":
                for field in MODEL_FIELDS:
                    config.pop(field, None)
            changed.append(f"{executor}/{name}")
    return updated, changed, skipped


def adapt_managed_codex_configs(profiles, command, *, check=False):
    """Honor each managed preset's CLI and CODEX_HOME, including env overrides."""
    seen = set()
    for preset in profiles.get('executors', {}).get('CODEX', {}).values():
        config = preset.get('CODEX', {})
        if not command or config.get('base_command_override') != command:
            continue
        env = {**os.environ, **(config.get('env') or {})}
        identity = (env.get('CODEX_HOME'), env.get('PR_CYCLE_CODEX_PATH'), env.get('PATH'), env.get('Path'))
        if identity in seen:
            continue
        seen.add(identity)
        probe = probe_clis('codex', env)['codex']
        if probe['available']:
            adapt_codex_config(probe, env, check=check)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=13680)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--executor", choices=("codex", "claude", "both"), default="both")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    commands = {}
    legacy_commands = {}
    probes = probe_clis()
    node = shutil.which("node")
    for name, executor in (("codex", "CODEX"), ("claude", "CLAUDE_CODE")):
        if args.executor not in (name, "both"):
            continue
        probe = probes[name]
        if probe["available"]:
            print(f"{name}: {probe['version']}\n  discovered on this machine: {probe['source']}")
            legacy_commands[executor] = command_line([probe['command'], *probe['args']])
        else:
            print(f"{name}: unavailable. {probe['error']}")
        if name == "codex":
            commands[executor] = command_line([node, BRIDGE])
        else:
            commands[executor] = command_line([node, LAUNCHER, name])

    def request(route, data=None):
        req = urllib.request.Request(
            f"http://127.0.0.1:{args.port}{route}",
            data=json.dumps(data).encode() if data is not None else None,
            method="PUT" if data is not None else "GET",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            result = json.load(response)
        if not result.get("success"):
            raise RuntimeError(f"Kanban rejected {route}; check its backend log")
        return result["data"]

    lock = json.loads((ROOT / "skills/pr-cycle/assets/runtime.lock.json").read_text())
    if request("/api/info")["config"]["last_app_version"] != lock["version"]:
        raise RuntimeError("Backend version differs from the pinned runtime")
    original = json.loads(request("/api/profiles")["content"])
    updated, changed, skipped = update_profiles(original, commands, legacy_commands)
    for item in changed:
        print(f"Local CLI: {item}")
    for item in skipped:
        print(f"Preserved: {item}")
    adapt_managed_codex_configs(updated, commands.get('CODEX'), check=args.check)
    if args.check or updated == original:
        print("Preview only." if args.check else "Already configured.")
        return
    backups = ROOT / ".pr-cycle-runtime/backups"
    backups.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = backups / f"profiles-before-local-clis-{timestamp}.json"
    backup.write_text(json.dumps(original, ensure_ascii=False, indent=2), encoding="utf-8")
    if json.loads(request("/api/profiles")["content"]) != original:
        raise RuntimeError("Profiles changed during inspection; retry after checking the UI")
    request("/api/profiles", updated)
    if json.loads(request("/api/profiles")["content"]) != updated:
        raise RuntimeError(f"Saved settings differ; inspect the UI. Backup: {backup}")
    print(f"Saved. New workers use local CLIs; running workers are unchanged.\nBackup: {backup}")


if __name__ == "__main__":
    main()
