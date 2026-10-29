"""Opt-in real local Codex smoke test (two short model calls, no project edits).

python tests/smoke_local_codex.py [--cli /path/to/codex]
Uses an isolated scratch repository and creates native Codex test sessions.
"""
import argparse
import json
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'skills/pr-cycle/scripts'))
from use_local_clis import discover_cli, BRIDGE


class Client:
    def __init__(self, cli, cwd):
        command = [shutil.which('node'), str(BRIDGE)]
        if cli:
            command += ['--cli', str(cli)]
        self.process = subprocess.Popen([*command, 'app-server'],
                                        cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True, encoding='utf-8')
        self.queue = queue.Queue()
        self.events = []
        self.sequence = 0
        threading.Thread(target=self.read, daemon=True).start()
        self.call('initialize', {'clientInfo': {'name': 'pr-cycle-bridge-smoke', 'version': '1.0'}})
        self.send({'method': 'initialized'})

    def read(self):
        for line in self.process.stdout:
            self.queue.put(json.loads(line))
        self.queue.put(None)

    def send(self, value):
        self.process.stdin.write(json.dumps(value) + '\n')
        self.process.stdin.flush()

    def receive(self):
        value = self.queue.get(timeout=60)
        if value is None:
            raise RuntimeError('Bridge closed before the expected response')
        self.events.append(value)
        if value.get('method') in ('execCommandApproval', 'applyPatchApproval'):
            self.send({'id': value['id'], 'result': {'decision': 'denied'}})
            raise RuntimeError('Unexpected tool approval in text-only smoke test (denied)')
        return value

    def call(self, method, params):
        self.sequence += 1
        self.send({'id': self.sequence, 'method': method, 'params': params})
        while True:
            value = self.receive()
            if value.get('id') == self.sequence:
                if 'error' in value:
                    raise RuntimeError(value['error'])
                return value['result']

    def turn(self, thread_id, prompt):
        self.call('addConversationListener', {'conversationId': thread_id})
        self.call('sendUserMessage', {'conversationId': thread_id, 'items': [{'type': 'text', 'text': prompt}]})
        while True:
            value = self.receive()
            if value.get('method') == 'codex/event/task_complete':
                return value['params']['msg']['last_agent_message']
            if value.get('method') == 'codex/event/error':
                raise RuntimeError(value['params']['msg']['message'])

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
            raise RuntimeError('Bridge did not shut down when stdin closed')
        if self.process.returncode != 0:
            raise RuntimeError(f'Bridge exited with code {self.process.returncode}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli')
    args = parser.parse_args()
    _, version = discover_cli('codex', args.cli)
    with tempfile.TemporaryDirectory(prefix='pr-cycle-cli-') as temp:
        subprocess.run(['git', 'init', '-q', temp], check=True)
        options = {'cwd': temp, 'sandbox': 'read-only', 'approvalPolicy': 'on-request',
                   'baseInstructions': 'Transport verification only. Never use tools. Follow the requested exact output.'}
        first = Client(args.cli, temp)
        marker = 'LOCAL_CLI_' + uuid.uuid4().hex[:8]
        try:
            session = first.call('newConversation', options)
            answer = first.turn(session['conversationId'], f'Remember this marker: {marker}. Reply with only the marker.')
            assert answer.strip() == marker, answer
            print(f'New conversation: PASS ({version}, model={session["model"]})')
        finally:
            first.close()
        # Match Vibe's forked-rollout behavior: new ID, copied history, explicit path.
        fork_id = str(uuid.uuid4())
        lines = Path(session['rolloutPath']).read_text(encoding='utf-8').splitlines()
        header = json.loads(lines[0])
        assert header['type'] == 'session_meta'
        header['payload']['id'] = fork_id
        lines[0] = json.dumps(header)
        fork_path = Path(temp) / f'rollout-{fork_id}.jsonl'
        fork_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        second = Client(args.cli, temp)
        try:
            resumed = second.call('resumeConversation', {'path': str(fork_path), 'overrides': options})
            assert resumed['conversationId'] == fork_id, resumed['conversationId']
            answer = second.turn(fork_id, 'Reply with only the marker from my previous message.')
            assert answer.strip() == marker, answer
            print('Forked rollout resume and remembered context: PASS')
        finally:
            second.close()
        assert not list(Path(temp).glob('*.txt'))
        print('stdin EOF shutdown: PASS')


if __name__ == '__main__':
    main()
