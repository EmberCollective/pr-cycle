"""Make built-in Kanban Codex presets inherit local model/provider settings.

No credentials are read or copied. Codex resolves its own config on launch.
Permissions and custom presets are preserved. The backend must be running.
"""

import argparse
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import urllib.request


ROOT = Path(__file__).resolve().parents[3]
VARIANTS = ("DEFAULT", "HIGH", "APPROVALS", "MAX")
MODEL_FIELDS = (
    "model", "model_provider", "profile", "model_reasoning_effort",
    "model_reasoning_summary", "model_reasoning_summary_format",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=13680)
    parser.add_argument("--check", action="store_true", help="Inspect without saving")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    base = f"http://127.0.0.1:{args.port}"

    def request(route, data=None):
        req = urllib.request.Request(
            base + route,
            data=json.dumps(data).encode() if data is not None else None,
            method="PUT" if data is not None else "GET",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            result = json.load(response)
        if not result.get("success"):
            raise RuntimeError(f"Kanban rejected {route}; check the backend log")
        return result["data"]

    lock = json.loads((ROOT / "skills/pr-cycle/assets/runtime.lock.json").read_text())
    if request("/api/info")["config"]["last_app_version"] != lock["version"]:
        raise RuntimeError("Backend version differs from the pinned runtime")
    original = json.loads(request("/api/profiles")["content"])
    updated = copy.deepcopy(original)
    presets = updated["executors"]["CODEX"]
    for name in VARIANTS:
        config = presets[name]["CODEX"]
        fields = [field for field in MODEL_FIELDS if field in config]
        print(f"CODEX/{name}: " + ("overrides " + ", ".join(fields) if fields else "inherits local settings"))
        for field in fields:
            del config[field]
    if args.check or updated == original:
        return
    # Refuse to overwrite a change made in the UI since our first read.
    if json.loads(request("/api/profiles")["content"]) != original:
        raise RuntimeError("Profiles changed during inspection; retry after checking the UI")
    backups = ROOT / ".pr-cycle-runtime/backups"
    backups.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = backups / f"profiles-before-codex-inheritance-{timestamp}.json"
    backup.write_text(json.dumps(original, ensure_ascii=False, indent=2), encoding="utf-8")
    request("/api/profiles", updated)
    actual = json.loads(request("/api/profiles")["content"])
    if actual != updated:
        raise RuntimeError(f"Saved settings differ from the requested change; backup: {backup}")
    print("Saved: built-in Codex presets now inherit local model/provider/reasoning settings.")
    print(f"Backup: {backup}")


if __name__ == "__main__":
    main()
