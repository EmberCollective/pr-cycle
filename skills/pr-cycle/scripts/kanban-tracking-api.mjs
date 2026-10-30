import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./kanban_tracking.py', import.meta.url));

export function trackingCommand({ database, python = 'python', install = false }, payload) {
  return new Promise((resolve, reject) => {
    const args = [script, ...(database ? ['--db', database] : []), ...(install ? ['--install'] : [])];
    const child = spawn(python, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('追踪数据库响应超时')); }, 15000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { error += chunk; });
    child.stdin.on('error', () => {});
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(output)); }
      catch { reject(new Error(error || '无法读取流程追踪记录')); }
    });
    child.stdin.end(JSON.stringify(payload ?? {}));
  });
}

export async function handleTrackingRequest(req, res, config) {
  const send = (status, body) => res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  }).end(JSON.stringify(body));
  if (!config) return send(503, { success: false, message: '请重启新版看板启动器以启用流程追踪' });
  try {
    let payload;
    if (req.method === 'GET') {
      payload = { action: 'read', project_id: new URL(req.url, 'http://localhost').searchParams.get('project_id') };
    } else if (req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) {
        return send(415, { success: false, message: 'Expected application/json' });
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 65536) return send(413, { success: false, message: 'Request too large' });
        chunks.push(chunk);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } else return send(405, { success: false, message: 'Method not allowed' });
    const result = await trackingCommand(config, payload);
    send(result.success ? 200 : 400, result);
  } catch (error) {
    send(error instanceof SyntaxError ? 400 : 503, { success: false, message: error.message });
  }
}
