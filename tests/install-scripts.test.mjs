/**
 * dsh-settings-plugin-hub —— 安装 / 回滚脚本测试。
 *
 * 在临时 profile 目录上真的跑一遍脚本（child_process），断言：
 *   · 幂等：连跑两次结果一致，且第二次不再动 package.json；
 *   · 可回滚：整文件还原备份、软链清理干净、不留残渣；
 *   · 安装后被别的改动岔开时，回滚只摘自己写的东西，不整文件覆盖。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  PACKAGE_NAME,
  installedPackageJson,
  isInstalledPackageJson,
  stripPackageJson,
  withBundle,
} from '../scripts/profile-edits.mjs';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-install-'));
  tempDirs.push(dir);
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

/** 造一个有内容的 profile 目录。 */
function buildProfile() {
  const profileDir = join(tempDir(), 'profiles', 'web');
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-other': '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-other'] } },
  }, null, 2)}\n`);
  return profileDir;
}

function runScript(script, profileDir, extraArgs = []) {
  return execFileSync(process.execPath, [join(PLUGIN_DIR, 'scripts', script), ...extraArgs], {
    env: { ...process.env, DSH_PROFILE_DIR: profileDir },
    encoding: 'utf8',
  });
}

describe('profile-edits 纯函数', () => {
  it('withBundle 追加且不重复', () => {
    assert.deepEqual(withBundle(['a'], 'x'), ['a', 'x']);
    assert.deepEqual(withBundle(['a', 'x'], 'x'), ['a', 'x']);
    assert.deepEqual(withBundle(undefined, 'x'), ['x']);
  });

  it('installedPackageJson 写 link 依赖并追加 bundle', () => {
    const next = installedPackageJson(JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: ['a'] } } }), '/x/y');
    const parsed = JSON.parse(next);
    assert.equal(parsed.dependencies[PACKAGE_NAME], 'link:/x/y');
    assert.deepEqual(parsed.dsh.profile.bundles, ['a', PACKAGE_NAME]);
  });

  it('stripPackageJson 只摘自己的痕迹，没有痕迹时返回 null', () => {
    const installed = installedPackageJson(JSON.stringify({ name: 'p', dependencies: { other: '1' }, dsh: { profile: { bundles: ['a'] } } }), '/x/y');
    const stripped = JSON.parse(stripPackageJson(installed));
    assert.deepEqual(stripped.dependencies, { other: '1' });
    assert.deepEqual(stripped.dsh.profile.bundles, ['a']);
    assert.equal(stripPackageJson(JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })), null);
  });

  it('isInstalledPackageJson 能识别「安装后又被人改过」', () => {
    const pre = JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } });
    const installed = installedPackageJson(pre, '/x/y');
    assert.equal(isInstalledPackageJson(installed, pre, '/x/y'), true);
    assert.equal(isInstalledPackageJson(installed.replace('"p"', '"p2"'), pre, '/x/y'), false);
  });
});

describe('安装 / 回滚脚本（真跑）', () => {
  it('安装 → 幂等 → 整文件回滚，且不留残渣', () => {
    const profileDir = buildProfile();
    const packageFile = join(profileDir, 'package.json');
    const bak = `${packageFile}.${PACKAGE_NAME}.bak`;
    const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME);
    const original = readFileSync(packageFile, 'utf8');

    // dry-run 不许碰文件
    const dryOutput = runScript('install-profile.mjs', profileDir, ['--dry-run']);
    assert.match(dryOutput, /dry-run/);
    assert.equal(readFileSync(packageFile, 'utf8'), original);
    assert.ok(!existsSync(linkPath));

    const first = runScript('install-profile.mjs', profileDir);
    assert.match(first, /已备份/);
    const installed = readFileSync(packageFile, 'utf8');
    assert.notEqual(installed, original);
    assert.deepEqual(JSON.parse(installed).dependencies[PACKAGE_NAME], `link:${PLUGIN_DIR}`);
    assert.ok(JSON.parse(installed).dsh.profile.bundles.includes(PACKAGE_NAME));
    assert.equal(realpathSync(linkPath), PLUGIN_DIR);
    assert.ok(existsSync(bak));

    // 幂等：第二次跑不该再改 package.json
    const second = runScript('install-profile.mjs', profileDir);
    assert.match(second, /已是安装后状态/);
    assert.equal(readFileSync(packageFile, 'utf8'), installed);

    // 回滚：整文件还原 + 消费备份 + 摘软链
    const rolled = runScript('rollback-profile.mjs', profileDir);
    assert.match(rolled, /已整文件还原/);
    assert.equal(readFileSync(packageFile, 'utf8'), original);
    assert.ok(!existsSync(bak));
    assert.ok(!existsSync(linkPath));

    // 再回滚一次：什么都不做
    const again = runScript('rollback-profile.mjs', profileDir);
    assert.match(again, /没有本插件的痕迹|找不到/);
  });

  it('安装之后 package.json 被别的改动岔开时，回滚只摘自己的痕迹', () => {
    const profileDir = buildProfile();
    const packageFile = join(profileDir, 'package.json');
    runScript('install-profile.mjs', profileDir);

    const modified = JSON.parse(readFileSync(packageFile, 'utf8'));
    modified.dependencies['dsh-later-plugin'] = '^2.0.0';
    writeFileSync(packageFile, `${JSON.stringify(modified, null, 2)}\n`);

    const output = runScript('rollback-profile.mjs', profileDir);
    assert.match(output, /未整文件覆盖/);
    const after = JSON.parse(readFileSync(packageFile, 'utf8'));
    assert.equal(PACKAGE_NAME in after.dependencies, false);
    assert.equal(after.dependencies['dsh-later-plugin'], '^2.0.0');
    assert.ok(!after.dsh.profile.bundles.includes(PACKAGE_NAME));
    assert.equal(existsSync(`${packageFile}.${PACKAGE_NAME}.bak`), true, '备份必须留给人工比对');
  });

  it('node_modules 里被换成真目录时也能删干净', () => {
    const profileDir = buildProfile();
    const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME);
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'stray.txt'), 'x');
    const output = runScript('rollback-profile.mjs', profileDir);
    assert.match(output, /已删除目录/);
    assert.ok(!existsSync(linkPath));
  });

  it('软链已指向本目录时不重复建链（幂等的关键）', () => {
    const profileDir = buildProfile();
    const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME);
    symlinkSync(PLUGIN_DIR, linkPath, 'dir');
    const output = runScript('install-profile.mjs', profileDir);
    assert.match(output, /软链已存在且指向本目录/);
  });
});
