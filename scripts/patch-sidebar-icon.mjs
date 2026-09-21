#!/usr/bin/env node
/**
 * dsh-settings-plugin-hub — 给「第三方插件」设置分页钉一个专属侧栏图标。
 *
 * DSH 渲染设置侧栏图标用的是硬编码的 id→图标映射（navIcon(id)，
 * 在 @deepseek-ai/dsh-client-ui-settings-general 里），settings.section 的
 * slot 契约没有 icon 字段 —— 不打这个小补丁，本分页只能落到默认齿轮
 * （和「通用」重样）。这里换成 IconCordisPluginOutline14：
 * 这些分页本来就是 Cordis 插件，语义最贴，且与「内置插件」的
 * Personalization 图标区分开。
 *
 * 幂等；首次打补丁时在旁边留 .dsh-settings-plugin-hub.bak。
 * DSH runtime 每次升级后需要重跑（与 dsh-search 的同名脚本同款做法，
 * 两个脚本各加各的分支，谁先谁后都不冲突）。
 *
 * 想换图标：改下面 ICON 常量（可用值见
 * @deepseek-ai/dsh-client-ui-primitives 的 Icon*Outline* 导出）。
 *
 * Usage: node scripts/patch-sidebar-icon.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 本分页的 id（与 lib/client.js 的 SECTION_ID 一致）。 */
const SECTION_ID = 'third-party-plugins';
/** 要用的官方图标。 */
const ICON = 'IconCordisPluginOutline14';
/** 备份/占位标记后缀。 */
const MARK = 'dsh-settings-plugin-hub';

const candidates = [
  process.env.DSH_RUNTIME && join(process.env.DSH_RUNTIME, 'node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js'),
  // 本机（fnOS app 布局）
  '/vol1/@appdata/deepseek.harness/dsh-runtime/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js',
  join(homedir(), '.dsh', 'runtime', 'node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js'),
].filter(Boolean);

const target = candidates.find((p) => existsSync(p));
if (!target) {
  console.error(`[${MARK}] 找不到 settings-general 的 client bundle；请设 DSH_RUNTIME 后重跑。`);
  process.exit(1);
}

let source = readFileSync(target, 'utf8');
if (source.includes(`id === "${SECTION_ID}"`)) {
  console.log(`[${MARK}] 图标补丁已存在：`, target);
  process.exit(0);
}

// 官方外壳 navIcon 的兜底分支（未知 id 一律齿轮）——新分支插在它前面。
const anchor = '\t\t\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutline16, {\n\t\t\t\tclassName: SettingsRoot_module_css_default.navIcon,\n\t\t\t\tsize: 16\n\t\t\t});\n\t\t}';
const inject = `\t\t\tif (id === "${SECTION_ID}") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.${ICON}, {\n\t\t\t\tclassName: SettingsRoot_module_css_default.navIcon,\n\t\t\t\tsize: 16\n\t\t\t});\n` + anchor;

if (!source.includes(anchor)) {
  console.error(`[${MARK}] 没找到 navIcon 的兜底分支（DSH bundle 变了？）；补丁未应用。`);
  process.exit(1);
}
if (!existsSync(`${target}.${MARK}.bak`)) copyFileSync(target, `${target}.${MARK}.bak`);
writeFileSync(target, source.replace(anchor, inject));
console.log(`[${MARK}] 侧栏图标已打补丁：${SECTION_ID} → ${ICON}（${target}）`);
console.log('重启 dsh 后生效；DSH 升级后需重跑本脚本。');
