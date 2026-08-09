import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// 生成一个 command 型 Stop hook：sentinel 不存在→block（exit 2 或 JSON decision），存在→allow。
// 同时每次执行写一行 log，用于验证 hook 是否真的每轮触发（含 resume 轮）。
export function writeHookSettings({ dir, sentinelPath }) {
  mkdirSync(dir, { recursive: true });
  const hookPath = join(dir, 'stop-hook.sh');
  const logPath = join(dir, 'hook-runs.log');
  const settingsPath = join(dir, 'settings.json');
  const script = `#!/bin/bash
echo "hook-ran $(date +%s)" >> ${JSON.stringify(logPath)}
if [ -f ${JSON.stringify(sentinelPath)} ]; then
  exit 0
else
  echo '{"decision":"block","reason":"sentinel not created yet; create it then stop"}'
  exit 0
fi
`;
  writeFileSync(hookPath, script); chmodSync(hookPath, 0o500);
  const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: hookPath }] }] } };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { settingsPath, hookPath, logPath };
}

// exit-2 变体：不写 JSON decision，而是 exit code 2 + stderr reason（block 协议探测点二）。
export function writeHookSettingsExit2({ dir, sentinelPath }) {
  mkdirSync(dir, { recursive: true });
  const hookPath = join(dir, 'stop-hook-exit2.sh');
  const logPath = join(dir, 'hook-runs-exit2.log');
  const settingsPath = join(dir, 'settings-exit2.json');
  const script = `#!/bin/bash
echo "hook-ran $(date +%s)" >> ${JSON.stringify(logPath)}
if [ -f ${JSON.stringify(sentinelPath)} ]; then
  exit 0
else
  echo "sentinel not created yet; create it then stop" >&2
  exit 2
fi
`;
  writeFileSync(hookPath, script); chmodSync(hookPath, 0o500);
  const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: hookPath }] }] } };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { settingsPath, hookPath, logPath };
}
