/**
 * dsh-settings-plugin-hub —— 市场投稿脚本测试。
 *
 * 只测「不需要 gh 登录、不碰网络」的那部分：条目文件定位、文件名/slug 规则、
 * 分支名与 PR 正文生成、以及 dry-run 的默认行为（默认绝不发网络请求）。
 * 真正提 PR 的那几条分支由 gh 决定成败，测试不去假装验证它。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { findEntryFile, planSubmission, UPSTREAM_DIR, validateEntryFileName } from '../scripts/submit-market-listing.mjs';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-submit-'));
  tempDirs.push(dir);
  return dir;
}

/** 造一个只有 market/ 的假插件目录。 */
function fakePluginDir(entries) {
  const dir = tempDir();
  mkdirSync(join(dir, 'market'), { recursive: true });
  for (const name of entries) writeFileSync(join(dir, 'market', name), 'url: https://github.com/a/b\n');
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
});

describe('findEntryFile', () => {
  it('本仓库里能定位到唯一那份条目', () => {
    const found = findEntryFile(PLUGIN_DIR);
    assert.equal(found.ok, true, found.error);
    assert.equal(found.name, 'huiikeung__dsh-settings-plugin-hub.yml');
  });

  it('没有 market/ 或没有 .yml 时给出可读错误', () => {
    const empty = tempDir();
    assert.match(findEntryFile(empty).error, /找不到 market\//);
    const noYml = tempDir();
    mkdirSync(join(noYml, 'market'));
    assert.match(findEntryFile(noYml).error, /没有 .yml/);
  });

  it('多个条目时拒绝（一次只提一个）', () => {
    const dir = fakePluginDir(['a__b.yml', 'c__d.yml']);
    assert.match(findEntryFile(dir).error, /多个条目/);
  });
});

describe('validateEntryFileName', () => {
  it('接受 <owner>__<repo>.yml', () => {
    const parsed = validateEntryFileName('huiikeung__dsh-settings-plugin-hub.yml');
    assert.deepEqual(parsed, { ok: true, owner: 'huiikeung', repo: 'dsh-settings-plugin-hub' });
  });

  it('拒绝不符合 slug 规则的文件名', () => {
    for (const name of ['dsh-settings-plugin-hub.yml', 'a_b.yml', 'a__b.yaml', 'a__b__c.yml']) {
      assert.equal(validateEntryFileName(name).ok, false, name);
    }
  });
});

describe('planSubmission', () => {
  it('分支名安全（小写、只留 [a-z0-9._-]）且标题点名 owner/repo', () => {
    const plan = planSubmission('huiikeung__dsh-settings-plugin-hub.yml');
    assert.equal(plan.ok, true);
    assert.equal(plan.branch, 'add-huiikeung__dsh-settings-plugin-hub');
    assert.equal(plan.title, 'Add huiikeung/dsh-settings-plugin-hub');
    assert.match(plan.body, /data\/plugins\//);
    assert.match(plan.body, /https:\/\/github\.com\/huiikeung\/dsh-settings-plugin-hub/);
  });

  it('落位目录与上游约定一致', () => {
    assert.equal(UPSTREAM_DIR, 'data/plugins');
  });

  it('文件名不合法时原样透传错误', () => {
    assert.equal(planSubmission('bad.yml').ok, false);
  });
});

describe('命令行默认行为', () => {
  it('默认是 dry-run：只打印计划，不碰 gh/git、不需要登录', () => {
    const output = execFileSync(process.execPath, [join(PLUGIN_DIR, 'scripts', 'submit-market-listing.mjs')], { encoding: 'utf8' });
    assert.match(output, /== 提交 huiikeung__dsh-settings-plugin-hub\.yml → awesome-dsh-plugin\/awesome-dsh-plugin ==/);
    assert.match(output, /data\/plugins\/huiikeung__dsh-settings-plugin-hub\.yml/);
    assert.match(output, /dry-run/);
    assert.ok(!output.includes('fork 上游并克隆'), 'dry-run 不能真的去 fork');
  });
});
