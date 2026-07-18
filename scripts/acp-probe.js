/**
 * Minimal ACP probe: spawn agent acp, send prompt, auto-approve permissions.
 * @author Amadeus
 */
const { spawn } = require('child_process');
const readline = require('readline');

const AGENT_BIN = process.env.AGENT_BIN || 'agent';
const WORKDIR = process.env.WORKDIR || process.cwd();
const PROMPT = process.argv[2] || 'Run: dir . and reply with file count only';

let msgId = 1;
const pending = new Map();
const results = {
  permissionRequests: [],
  autoApproved: 0,
  logChunks: [],
  errors: [],
  done: false,
};

function send(method, params = {}) {
  const id = msgId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function respond(id, result) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

const child = spawn(AGENT_BIN, ['acp'], {
  cwd: WORKDIR,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  shell: true,
});

child.stderr.on('data', (buf) => {
  const text = buf.toString();
  if (text.trim()) results.errors.push(text.trim());
});

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.id && (msg.result || msg.error)) {
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      msg.error ? waiter.reject(msg.error) : waiter.resolve(msg.result);
    }
    return;
  }

  if (msg.method === 'session/update') {
    const update = msg.params?.update;
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
      results.logChunks.push(update.content.text);
    }
    return;
  }

  if (msg.method === 'session/request_permission') {
    const tool = msg.params?.toolCall?.title || msg.params?.toolCall?.kind || 'unknown';
    results.permissionRequests.push(tool);
    results.autoApproved += 1;
    respond(msg.id, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
    return;
  }

  if (msg.method === 'cursor/create_plan') {
    respond(msg.id, { accepted: true });
  }
});

async function main() {
  const timeout = setTimeout(() => {
    results.errors.push('TIMEOUT after 90s');
    child.kill();
  }, 90000);

  try {
    await send('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await send('authenticate', { methodId: 'cursor_login' });
    const session = await send('session/new', { cwd: WORKDIR, mcpServers: [] });
    await send('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: PROMPT }],
    });
    results.done = true;
  } catch (err) {
    results.errors.push(String(err.message || err));
  } finally {
    clearTimeout(timeout);
    child.kill();
    console.log(JSON.stringify(results, null, 2));
  }
}

main();
