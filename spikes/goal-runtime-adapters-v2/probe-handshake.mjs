import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'spike-handshake-'));
const codexHome = join(scratch, 'codex-home');
mkdirSync(codexHome, { recursive: true });
const client = new AppServerClient({ mode: 'stdio', codexHome, cwd: scratch });
await client.start();

const out = { codexHome };
try {
  // 探测 1：initialize（先空 params，失败再迭代）
  try {
    out.initialize = await client.rpc('initialize', { clientInfo: { name: 'goal-condition-spike', version: '0' } });
  } catch (e) { out.initializeError = String(e); }
  // 探测 2：thread/start ephemeral
  out.threadStart = await client.rpc('thread/start', { ephemeral: true, cwd: scratch, sandbox: 'read-only' });
  out.threadId = out.threadStart?.result?.thread?.threadId ?? out.threadStart?.result?.thread?.id;
} finally {
  writeFileSync(join(scratch, 'handshake.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log('SCRATCH=' + scratch);
  await client.stop();
}
