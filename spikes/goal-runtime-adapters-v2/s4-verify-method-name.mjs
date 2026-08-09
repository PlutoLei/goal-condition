import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// fix round 1（review Important #2）：report/矩阵里"-32600 枚举出全部合法 method，唯一存在
// thread/inject_items（下划线）"这条描述，原始来源是第一次被手动 SIGTERM 中断的作废运行，没有
// 落 fixture，是纯回忆、不可复核。这里用一次零成本探测重新坐实——thread/inject-items（错误的
// 连字符版本）在 method 路由阶段就被拒绝，根本不会走到任何 turn/model 调用，跟 initialize/
// thread/start/thread/goal/set 一样不消耗真实 API（S1b 已实测这几个 RPC 的 tokensUsed 恒为 0），
// 所以不需要复制生产 auth.json，也不产生真实 API 消耗——不违反"这个时段 API 不稳，自测/探测
// 不烧真实 API"的要求。
const codexHome = mkdtempSync(join(tmpdir(), 'spike-s4-probe-codex-home-'));
const work = mkdtempSync(join(tmpdir(), 'spike-s4-probe-work-'));
const c = new AppServerClient({ mode: 'stdio', codexHome, cwd: work });
const rec = {};
try {
  await c.start(); await c.initialize();
  const { threadId } = await c.threadStart({ ephemeral: false, sandbox: 'workspace-write', cwd: work });
  rec.threadId = threadId;

  const bad = await c.rpc('thread/inject-items', { threadId, items: [] }); // brief 写的连字符版本
  rec.wrongMethodResponse = bad.error ?? bad.result;
  rec.wrongMethodIsError = !!bad.error;
  rec.errorEnumeratesUnderscoreVariant = /thread\/inject_items/.test(JSON.stringify(bad.error ?? ''));
  rec.errorContainsHyphenVariant = /thread\/inject-items/.test(JSON.stringify(bad.error ?? ''));
  console.log('wrong-method (thread/inject-items) probe: isError=', rec.wrongMethodIsError,
    '| enumerates thread/inject_items?', rec.errorEnumeratesUnderscoreVariant,
    '| enumerates thread/inject-items (连字符)?', rec.errorContainsHyphenVariant);

  const good = await c.rpc('thread/inject_items', { threadId, items: [] }); // 下划线版本，空 items 数组，不实际注入内容
  rec.correctMethodResponse = good.error ?? good.result;
  rec.correctMethodIsError = !!good.error;
  console.log('correct-method (thread/inject_items) probe: isError=', rec.correctMethodIsError, JSON.stringify(rec.correctMethodResponse));
} finally {
  writeFileSync(join(process.env.REPO_FIX ?? '.', 's4-method-name-probe.json'), JSON.stringify(rec, null, 2));
  await c.stop();
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  console.log('cleaned up:', codexHome, work);
}
