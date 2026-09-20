#!/usr/bin/env node
// dsh-settings-plugin-hub — 把 market/*.yml 提交到 awesome-dsh-plugin（市场列表的上游）
//
//   node scripts/submit-market-listing.mjs            # 只看会做什么（默认 dry-run）
//   node scripts/submit-market-listing.mjs --yes      # 真提：fork → 分支 → 放文件 → commit → push → PR
//
// 为什么需要脚本：市场（dshmarket）自己不持有插件列表，它实时拉
// awesome-dsh-plugin 发布的 plugins.json；而「提交」= 往那个仓库的
// data/plugins/ 放一个 <owner>__<repo>.yml 并提 PR。手工做要 fork/建分支/对齐文件名，
// 脚本把这些机械步骤做掉，并且默认不动网络。
//
// 前置：`gh auth login` 一次（脚本用 gh 做 fork 与建 PR，用 git 做分支与推送）。
// 依赖：gh、git、网络。脚本只在临时目录里克隆、改动、推送，不碰你的工作区。

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 上游列表仓库（市场的数据源）。 */
export const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin';
/** 条目在插件仓库里的存放目录。 */
export const MARKET_DIR = 'market';
/** 上游放条目文件的目录。 */
export const UPSTREAM_DIR = 'data/plugins';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 找出 market/ 下唯一的条目文件；0 个或多个都算配置错误。 */
export function findEntryFile(pluginDir = PLUGIN_DIR) {
  const dir = join(pluginDir, MARKET_DIR);
  if (!existsSync(dir)) return { ok: false, error: `找不到 ${MARKET_DIR}/ 目录` };
  const files = readdirSync(dir).filter((name) => name.endsWith('.yml'));
  if (files.length === 0) return { ok: false, error: `${MARKET_DIR}/ 下没有 .yml 条目` };
  if (files.length > 1) return { ok: false, error: `${MARKET_DIR}/ 下有多个条目（${files.join(', ')}），本脚本一次只提一个` };
  return { ok: true, file: join(dir, files[0]), name: files[0] };
}

/** 条目文件名必须是 <owner>__<repo>.yml —— 上游按 slug 对齐文件名。 */
export function validateEntryFileName(name) {
  const match = /^([^_/]+)__([^_/]+)\.yml$/.exec(name);
  if (match === null) return { ok: false, error: `条目文件名必须形如 <owner>__<repo>.yml（收到 ${name}）` };
  return { ok: true, owner: match[1], repo: match[2] };
}

/** PR 的分支名与标题（纯函数，便于测试）。 */
export function planSubmission(name) {
  const parsed = validateEntryFileName(name);
  if (parsed.ok !== true) return parsed;
  const slug = basename(name, '.yml');
  return {
    ok: true,
    branch: `add-${slug}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 60),
    title: `Add ${parsed.owner}/${parsed.repo}`,
    body: [
      `Adds \`${name}\` to \`${UPSTREAM_DIR}/\`.`,
      '',
      'The plugin installs with `dsh plugin add` and declares a `dsh.bundle` patch layer;',
      'it has no build step, so nothing needs `allowBuilds`.',
      '',
      `Repo: https://github.com/${parsed.owner}/${parsed.repo}`,
    ].join('\n'),
  };
}

/** 跑一条命令，返回 {ok, out}。失败时把输出原样带回，交给调用方决定怎么讲。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, status: result.status, out };
}

function main() {
  const yes = process.argv.includes('--yes');
  const entry = findEntryFile();
  if (entry.ok !== true) {
    console.error(`  ✗ ${entry.error}`);
    process.exitCode = 1;
    return;
  }
  const plan = planSubmission(entry.name);
  if (plan.ok !== true) {
    console.error(`  ✗ ${plan.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`== 提交 ${entry.name} → ${UPSTREAM} ==`);
  console.log(`  · 分支：${plan.branch}`);
  console.log(`  · 标题：${plan.title}`);
  console.log(`  · 落位：${UPSTREAM_DIR}/${entry.name}`);

  if (!yes) {
    console.log('\n（dry-run）要真提就加 --yes；它会用 gh fork 上游、在临时目录提 PR。');
    console.log('前置：gh auth login 一次。');
    return;
  }

  const auth = run('gh', ['auth', 'status']);
  if (!auth.ok) {
    console.error(`  ✗ gh 未登录，先跑：gh auth login\n${auth.out}`);
    process.exitCode = 1;
    return;
  }

  const workdir = mkdtempSync(join(tmpdir(), 'adp-submit-'));
  const clone = join(workdir, 'repo');
  try {
    console.log('  · fork 上游并克隆…');
    const fork = run('gh', ['repo', 'fork', UPSTREAM, '--clone', '--remote', '--', clone]);
    if (!fork.ok) throw new Error(`gh repo fork 失败：${fork.out}`);

    const branch = run('git', ['-C', clone, 'checkout', '-b', plan.branch]);
    if (!branch.ok) throw new Error(`建分支失败：${branch.out}`);

    mkdirSync(join(clone, UPSTREAM_DIR), { recursive: true });
    copyFileSync(entry.file, join(clone, UPSTREAM_DIR, entry.name));

    const add = run('git', ['-C', clone, 'add', `${UPSTREAM_DIR}/${entry.name}`]);
    if (!add.ok) throw new Error(`git add 失败：${add.out}`);
    const commit = run('git', ['-C', clone, 'commit', '-m', plan.title]);
    if (!commit.ok) throw new Error(`git commit 失败：${commit.out}`);
    const push = run('git', ['-C', clone, 'push', '-u', 'origin', plan.branch]);
    if (!push.ok) throw new Error(`git push 失败：${push.out}`);
    const pr = run('gh', ['pr', 'create', '--repo', UPSTREAM, '--title', plan.title, '--body', plan.body, '--head', plan.branch]);
    if (!pr.ok) throw new Error(`gh pr create 失败：${pr.out}`);
    console.log(`  ✓ 已提 PR：${pr.out.split('\n').filter(Boolean).pop()}`);
    console.log('  · 仓库年龄不足 1 天时 CI 会红，但那种红每 6 小时自动重跑，不用重提。');
  } catch (error) {
    console.error(`  ✗ ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
