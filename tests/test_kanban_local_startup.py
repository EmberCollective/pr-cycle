"""Exercise real Windows launcher lifecycle with a fake backend; no AI calls."""
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'skills/pr-cycle/scripts/start-kanban.ps1'


@unittest.skipUnless(os.name == 'nt' and all(shutil.which(x) for x in ('node', 'git', 'powershell')), 'Windows launcher test')
class KanbanLocalStartupTests(unittest.TestCase):
    def test_reused_backend_gets_portable_bindings_without_being_stopped(self):
        profiles = {'executors': {name: {'DEFAULT': {name: {}}} for name in ['CODEX', 'CLAUDE_CODE']}}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                data = {'config': {'last_app_version': '0.0.166'}} if self.path == '/api/info' else {'content': json.dumps(profiles)}
                self.respond(data)

            def do_PUT(self):
                profiles.clear()
                profiles.update(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.respond({})

            def respond(self, data):
                body = json.dumps({'success': True, 'data': data}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            result = subprocess.run(['powershell', '-NoProfile', '-File', str(SCRIPT), '-BackendOnly', '-Port', str(server.server_port)],
                                    capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            codex = profiles['executors']['CODEX']['DEFAULT']['CODEX']
            claude = profiles['executors']['CLAUDE_CODE']['DEFAULT']['CLAUDE_CODE']
            self.assertIn('codex-local-bridge.mjs', codex['base_command_override'])
            self.assertNotIn('--cli', codex['base_command_override'])
            self.assertIn('local-cli.mjs', claude['base_command_override'])
            self.assertEqual(codex['env']['PR_CYCLE_LOCAL_CLI'], '1')
            with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/api/info') as response:
                self.assertEqual(response.status, 200)
        finally:
            server.shutdown()
            server.server_close()

    def test_fresh_backend_is_configured_before_ready_and_launcher_exits_with_child(self):
        self.check_fresh_backend(backend_only=True)

    def test_all_browser_entry_ports_serve_replacement_and_api_stays_on_public_port(self):
        self.check_fresh_backend(backend_only=False)

    def check_fresh_backend(self, backend_only):
        with tempfile.TemporaryDirectory(prefix='pr-cycle startup ') as temp:
            folder = Path(temp)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            extra_ports = []
            for _ in range(2):
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    extra_ports.append(sock.getsockname()[1])
            runtime = folder / 'runtime'
            commit = json.loads((ROOT / 'skills/pr-cycle/assets/runtime.lock.json').read_text())['commit']
            dist = runtime / f'vibe-kanban-{commit}/frontend/dist'
            dist.mkdir(parents=True)
            (dist / 'index.html').write_text('<html>replacement frontend</html>')
            tracking_db = folder / 'test-tracking.sqlite'
            db = sqlite3.connect(tracking_db)
            db.execute('CREATE TABLE tasks(id BLOB PRIMARY KEY,project_id BLOB,title TEXT,description TEXT,status TEXT)')
            db.close()
            # Substitute only npx in the child's PATH; never start a second real DB server.
            backend = folder / 'fake_backend.py'
            backend.write_text('''import json,os,threading
from http.server import BaseHTTPRequestHandler,HTTPServer
profiles={'executors':{'CODEX':{'DEFAULT':{'CODEX':{}}},'CLAUDE_CODE':{'DEFAULT':{'CLAUDE_CODE':{}}}}}
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  data={'config':{'last_app_version':'0.0.166'}} if self.path=='/api/info' else {'content':json.dumps(profiles)}
  self.respond(data)
 def do_PUT(self):
  profiles.clear();profiles.update(json.loads(self.rfile.read(int(self.headers['Content-Length']))));self.respond({})
 def do_POST(self):
  self.respond({});threading.Thread(target=self.server.shutdown,daemon=True).start()
 def respond(self,data):
  body=json.dumps({'success':True,'data':data}).encode();self.send_response(200);self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=HTTPServer((os.environ['HOST'],int(os.environ['PORT'])),Handler)
server.serve_forever();server.server_close()
''', encoding='utf-8')
            (folder / 'npx.cmd').write_text(f'@echo off\n"{sys.executable}" "{backend}"\n', encoding='utf-8')
            env = {**os.environ, 'PATH': str(folder) + os.pathsep + os.environ['PATH'],
                   'PR_CYCLE_CODEX_PATH': str(folder / 'missing-codex.exe'),
                   'PR_CYCLE_CLAUDE_PATH': str(folder / 'missing-claude.exe')}
            with (folder / 'launcher.log').open('w', encoding='utf-8') as log:
                mode_args = ['-BackendOnly'] if backend_only else ['-FrontendPort', str(extra_ports[0]), '-BackendPort', str(extra_ports[1]), '-TrackingDatabase', str(tracking_db)]
                proc = subprocess.Popen(['powershell', '-NoProfile', '-File', str(SCRIPT), *mode_args,
                                         '-Port', str(port), '-RuntimePath', str(runtime)],
                                        stdout=log, stderr=log, env=env)
                try:
                    ready = False
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline:
                        try:
                            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/profiles', timeout=1) as response:
                                data = json.loads(json.load(response)['data']['content'])
                            ready = data['executors']['CODEX']['DEFAULT']['CODEX'].get('env', {}).get('PR_CYCLE_LOCAL_CLI') == '1'
                        except (OSError, KeyError):
                            pass
                        if ready or proc.poll() is not None:
                            break
                        time.sleep(0.15)
                    self.assertTrue(ready, (folder / 'launcher.log').read_text(encoding='utf-8'))
                    if not backend_only:
                        for entry_port in [port, *extra_ports]:
                            with urllib.request.urlopen(f'http://127.0.0.1:{entry_port}/projects/test') as response:
                                self.assertIn('replacement frontend', response.read().decode())
                    # Allow the launcher's final profile verification to complete.
                    time.sleep(0.5)
                    with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/api/stop', data=b''), timeout=2):
                        pass
                    proc.wait(timeout=10)
                    self.assertEqual(proc.returncode, 0, (folder / 'launcher.log').read_text(encoding='utf-8'))
                finally:
                    if proc.poll() is None:
                        subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'], capture_output=True)
                        proc.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
