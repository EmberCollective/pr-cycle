"""Remove a known obsolete user setting only after the installed CLI rejects it.

The probe uses an isolated synthetic config, sends no model requests, and does
not expose the user's configuration in logs. Python 3.10 can still launch the
board; automatic migration requires tomllib (3.11+) or tomli.
"""

import copy
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import uuid

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None


KEY = 'disable_response_storage'
SETTING_LINE = re.compile(
    r'''^[ \t]*(?:disable_response_storage|"disable_response_storage"|'disable_response_storage')'''
    r'[ \t]*=[ \t]*(?:true|false)[ \t]*(?:#[^\r\n]*)?(?:\r?\n)?$'
)


def without_obsolete_setting(raw):
    """Return a byte-preserving edit only when TOML semantics prove it safe."""
    if tomllib is None:
        return None
    bom = b'\xef\xbb\xbf' if raw.startswith(b'\xef\xbb\xbf') else b''
    text = raw[len(bom):].decode('utf-8')
    parsed = tomllib.loads(text)
    if type(parsed.get(KEY)) is not bool:
        return None
    expected = copy.deepcopy(parsed)
    del expected[KEY]
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if not SETTING_LINE.fullmatch(line):
            continue
        candidate = ''.join(lines[:index] + lines[index + 1:])
        try:
            if tomllib.loads(candidate) == expected:
                return bom + candidate.encode('utf-8')
        except ValueError:
            continue
    return None


def rejects_obsolete_setting(launch, env):
    """Unknown/older CLI behavior is inconclusive, never permission to edit."""
    with tempfile.TemporaryDirectory(prefix='pr-cycle-config-probe-') as folder:
        config = Path(folder) / 'config.toml'
        config.write_text(f'{KEY} = true\n', encoding='utf-8')
        result = subprocess.run(
            [launch['command'], *launch.get('args', []), '--strict-config', 'app-server'],
            input='', capture_output=True, text=True, encoding='utf-8', errors='replace',
            cwd=folder, env={**env, 'CODEX_HOME': folder}, timeout=15,
        )
        evidence = f'{config}:1:1: unknown configuration field `{KEY}`'
        return result.returncode != 0 and evidence in result.stderr


def adapt_codex_config(launch, env=None, *, check=False, report=print):
    env = dict(os.environ if env is None else env)
    home = Path(env.get('CODEX_HOME') or Path.home() / '.codex').expanduser()
    config = home / 'config.toml'
    lock = config.with_name('config.toml.pr-cycle-compat.lock')
    locked = False
    try:
        if not config.exists() or config.is_symlink():
            return False
        original = config.read_bytes()
        if KEY.encode() not in original:
            return False
        if tomllib is None:
            report('Codex config compatibility: Python 3.11+ or tomli is needed; config unchanged.')
            return False
        replacement = without_obsolete_setting(original)
        if replacement is None or not rejects_obsolete_setting(launch, env):
            return False
        if check:
            report(f'Codex config compatibility: would back up and remove ignored {KEY} from {config}.')
            return False
        # Serialize our own launchers, then recheck for external editor changes.
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        locked = True
        mode = stat.S_IMODE(config.stat().st_mode)
        if config.is_symlink() or config.read_bytes() != original:
            report('Codex config compatibility: config changed during inspection; retry next startup.')
            return False
        if not mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH):
            report('Codex config compatibility: config is read-only; unchanged.')
            return False
        backup = config.with_name(f'config.toml.before-pr-cycle-compat-{uuid.uuid4().hex}.bak')
        with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
            stream.write(original)
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(dir=config.parent, prefix='.pr-cycle-config-', delete=False) as stream:
                temp_path = Path(stream.name)
                stream.write(replacement)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temp_path, mode)
            if config.is_symlink() or config.read_bytes() != original:
                report('Codex config compatibility: config changed before saving; unchanged.')
                return False
            os.replace(temp_path, config)
        finally:
            if temp_path is not None and temp_path.exists():
                temp_path.unlink()
        report(f'Codex config compatibility: removed ignored {KEY}; backup: {backup}')
        return True
    except (OSError, ValueError, subprocess.SubprocessError):
        # A failed optional migration must neither erase settings nor block work.
        # Native CLI warnings remain visible, including unrelated unknown keys.
        report('Codex config compatibility: could not safely migrate config; unchanged. Native diagnostics remain enabled.')
        return False
    finally:
        if locked:
            try:
                lock.unlink(missing_ok=True)
            except OSError:
                report('Codex config compatibility: could not release migration lock; check file permissions.')
