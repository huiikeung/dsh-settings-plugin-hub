#!/usr/bin/env node
// dsh-settings-plugin-hub — 从 DSH web profile 回滚安装
//
//   node scripts/rollback-profile.mjs
//
// 安全策略（避免「回滚把安装之后的新改动一起抹掉」）：
//   · 有 package.json.dsh-settings-plugin-hub.bak，且当前文件**仍然等于安装后的状态**
//     → 整文件还原备份；
//   · 有备份，但当前文件在安装之后又被改过（别的插件、手工编辑）
//     → 只反向摘掉本脚本写的东西，未整文件覆盖，备份保留供人工比对；
//   · 没有备份 → 反向摘除。
//
// 本插件不写任何 settings namespace，不碰 settings.yaml，因此没有别的残留。

import { copyFileSync, existsSync, lstatSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME, isInstalledPackageJson, stripPackageJson } from './profile-edits.mjs';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? '/vol1/@appdata/deepseek.harness/dsh-data/profiles/web';

const notes = [];
const warnings = [];

function main() {
  const packageFile = join(PROFILE_DIR, 'package.json');
  const bak = `${packageFile}.${PACKAGE_NAME}.bak`;

  if (existsSync(packageFile)) {
    const current = readFileSync(packageFile, 'utf8');
    if (!existsSync(bak)) {
      const next = stripPackageJson(current);
      if (next !== null) {
        writeFileSync(packageFile, next, 'utf8');
        notes.push(`已反向摘除 package.json 里的安装改动（无备份可整文件还原）`);
      } else {
        notes.push('package.json 没有本插件的痕迹（未改动）');
      }
    } else {
      const pre = readFileSync(bak, 'utf8');
      if (isInstalledPackageJson(current, pre, PLUGIN_DIR)) {
        copyFileSync(bak, packageFile);
        unlinkSync(bak);
        notes.push('已整文件还原 package.json（备份已消费）');
      } else {
        const next = stripPackageJson(current);
        if (next !== null) writeFileSync(packageFile, next, 'utf8');
        warnings.push(`package.json 在安装之后被改过：只摘除了本插件的改动，未整文件覆盖；备份保留在 ${bak} 供人工比对`);
      }
    }
  } else {
    warnings.push(`找不到 ${packageFile}`);
  }

  const linkPath = join(PROFILE_DIR, 'node_modules', PACKAGE_NAME);
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      unlinkSync(linkPath);
      notes.push(`已删除 ${linkPath}`);
    } else if (stat.isDirectory()) {
      rmSync(linkPath, { recursive: true, force: true });
      notes.push(`已删除目录 ${linkPath}`);
    }
  } catch {
    /* 本来就不在 */
  }

  console.log(`== ${PACKAGE_NAME} 回滚 ==`);
  for (const note of notes) console.log(`  · ${note}`);
  for (const warning of warnings) console.log(`  ⚠ ${warning}`);
  console.log('\n下一步：重启 dsh —— 左侧栏会恢复成「每个第三方分页各占一行」的原生形状。');
}

main();
