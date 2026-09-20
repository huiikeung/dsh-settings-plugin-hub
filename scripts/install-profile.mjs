#!/usr/bin/env node
// dsh-settings-plugin-hub — 安装到 DSH web profile（幂等，先备份，可一键回滚）
//
//   node scripts/install-profile.mjs            # 真装
//   node scripts/install-profile.mjs --dry-run  # 只打印将要做的改动
//
// 做的事：
//   1. 备份 profile 的 package.json（package.json.dsh-settings-plugin-hub.bak；
//      已存在则不覆盖，保证备份是「安装前」的原样）
//   2. package.json：dependencies 加 link: 依赖，dsh.profile.bundles 追加本包
//   3. profile/node_modules 里建同名软链（pnpm link: 的等价物）
//   4. 打印下一步（重启 dsh / 刷新页面）
//
// 不碰 pnpm-lock.yaml：package.json 的 link: 依赖足以让后续任何一次 pnpm install
// 重新物化这个软链。
//
// 官方替代：dsh plugin --profile web add -w dsh-settings-plugin-hub@link:<本目录>

import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME, installedPackageJson } from './profile-edits.mjs';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? '/vol1/@appdata/deepseek.harness/dsh-data/profiles/web';
const DRY_RUN = process.argv.includes('--dry-run');

const notes = [];

function backup(file) {
  if (!existsSync(file)) return;
  const target = `${file}.${PACKAGE_NAME}.bak`;
  if (existsSync(target)) {
    notes.push(`备份已存在，保持不动：${target}`);
    return;
  }
  if (DRY_RUN) {
    notes.push(`将备份 ${file} → ${target}`);
    return;
  }
  copyFileSync(file, target);
  notes.push(`已备份 ${file} → ${target}`);
}

function main() {
  const packageFile = join(PROFILE_DIR, 'package.json');
  if (!existsSync(packageFile)) {
    console.error(`  ✗ 找不到 profile：${packageFile}`);
    console.error('    用 DSH_PROFILE_DIR=<profile 目录> 指定，或先确认 dsh web 已至少启动过一次。');
    process.exitCode = 1;
    return;
  }

  backup(packageFile);

  const prePackage = readFileSync(packageFile, 'utf8');
  const nextPackage = installedPackageJson(prePackage, PLUGIN_DIR);
  if (nextPackage !== prePackage) {
    if (DRY_RUN) {
      notes.push(`将修改 package.json：dependencies.${PACKAGE_NAME} = link:${PLUGIN_DIR}；dsh.profile.bundles += ${PACKAGE_NAME}`);
    } else {
      writeFileSync(packageFile, nextPackage, 'utf8');
      notes.push(`package.json：dependencies.${PACKAGE_NAME} = link:${PLUGIN_DIR}；bundles += ${PACKAGE_NAME}`);
    }
  } else {
    notes.push('package.json 已是安装后状态（未改动）');
  }

  const linkPath = join(PROFILE_DIR, 'node_modules', PACKAGE_NAME);
  let needsLink = true;
  try {
    // realpathSync 才会跟随软链：要判断的是「链指向哪里」，不是「链自己的路径」。
    if (lstatSync(linkPath).isSymbolicLink() && realpathSync(linkPath) === PLUGIN_DIR) needsLink = false;
  } catch {
    /* 不存在 */
  }
  if (needsLink) {
    if (DRY_RUN) {
      notes.push(`将建立软链 node_modules/${PACKAGE_NAME} → ${PLUGIN_DIR}`);
    } else {
      try {
        unlinkSync(linkPath);
      } catch {
        /* 不存在 */
      }
      symlinkSync(PLUGIN_DIR, linkPath, 'dir');
      notes.push(`node_modules/${PACKAGE_NAME} → ${PLUGIN_DIR}`);
    }
  } else {
    notes.push(`软链已存在且指向本目录（未改动）`);
  }

  console.log(`== ${PACKAGE_NAME} 安装${DRY_RUN ? '（dry-run）' : ''} ==`);
  for (const note of notes) console.log(`  · ${note}`);
  console.log('\n下一步：重启 dsh（宿主半边要注册 HTTP 端点，浏览器半边要进客户端模块图）。');
  console.log('重启后打开 设置 → 第三方插件：左侧栏里第三方分页会被收进这一个入口。');
  console.log('回滚：node scripts/rollback-profile.mjs 然后重启。');
}

main();
