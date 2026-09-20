/**
 * dsh-settings-plugin-hub —— 「固定在左侧栏显示」的白名单存储（宿主半边）。
 *
 * 收纳是默认，固定是显式例外：用户挑出来的分页不藏，其余照收。这份选择必须
 * 跨重启、跨浏览器生效，所以落在宿主的 `$DSH_HOME/plugin-data/<插件>/pins.json`。
 *
 * 为什么不用 DSH 的 settings namespace：本插件刻意不 import 任何 @deepseek-ai/*
 * 包（link: 安装的插件不必依赖 profile 的模块解析），而一个 UI 偏好写成一个小
 * JSON 已经足够；目录沿用本机既有约定（plugin-data/archived-chats 同款）。
 *
 * 文件形状（按 profile 分桶，一份文件服务多个 profile）：
 *   { "version": 1, "profiles": { "web": { "pins": ["vision"], "updatedAt": 169… } } }
 *
 * 读写都不抛：写不进去时如实返回错误，调用方负责回退到「没有固定项 = 全部收纳」，
 * 一个 UI 偏好坏了绝不能连带插件失效。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 文件格式版本；将来结构变化时用它做迁移判断。 */
export const PINS_VERSION = 1;
/** 单个 profile 的固定项上限（分页总数远小于此，纯属防御）。 */
export const PINS_CAP = 200;
/** 单个分页 id 的长度上限。 */
const ID_CAP = 120;

/**
 * 收敛任意输入为合法的固定项列表：字符串、去空白、去重、截断。
 * @param {unknown} input - 端点收到的 pins 字段或文件里的数组。
 * @param {number} [cap] - 上限。
 * @returns {string[]}
 */
export function normalizePins(input, cap = PINS_CAP) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim().slice(0, ID_CAP);
    if (id === '' || out.includes(id)) continue;
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

/** 在固定集合里翻转一个 id（纯函数，供客户端乐观更新与测试复用）。 */
export function togglePin(pins, id) {
  const list = normalizePins(pins);
  if (typeof id !== 'string' || id.trim() === '') return list;
  const key = id.trim();
  const at = list.indexOf(key);
  if (at >= 0) list.splice(at, 1);
  else list.push(key);
  return list;
}

/**
 * pins.json 的路径。
 * @param {string} dshHome - DSH 数据根目录。
 * @param {string} [pluginName] - plugin-data 下的插件目录名。
 */
export function pinsFilePath(dshHome, pluginName = 'dsh-settings-plugin-hub') {
  if (typeof dshHome !== 'string' || dshHome.trim() === '') return null;
  return join(dshHome, 'plugin-data', pluginName, 'pins.json');
}

/** 读文件并解析；任何异常都退化成一个空对象。 */
function readStore(file) {
  try {
    if (!existsSync(file)) return { store: { version: PINS_VERSION, profiles: {} }, error: null };
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { store: { version: PINS_VERSION, profiles: {} }, error: 'pins file is not an object' };
    }
    const profiles = parsed.profiles !== null && typeof parsed.profiles === 'object' && !Array.isArray(parsed.profiles)
      ? parsed.profiles
      : {};
    return {
      store: { version: PINS_VERSION, profiles },
      error: parsed.version !== PINS_VERSION ? `unexpected pins file version: ${String(parsed.version)}` : null,
    };
  } catch (error) {
    return { store: { version: PINS_VERSION, profiles: {} }, error: `cannot read pins file: ${error?.message ?? String(error)}` };
  }
}

/**
 * 读某个 profile 的固定项。
 * @param {string|null} file - pinsFilePath 的返回值。
 * @param {string} profile - profile 名。
 * @returns {{pins: string[], updatedAt: number, error: string|null}}
 */
export function readPins(file, profile) {
  if (file === null) return { pins: [], updatedAt: 0, error: 'pins file path unresolved' };
  const { store, error } = readStore(file);
  const bucket = store.profiles[profile];
  const pins = bucket !== null && typeof bucket === 'object' ? normalizePins(bucket.pins) : [];
  const updatedAt = bucket !== null && typeof bucket === 'object' && Number.isFinite(Number(bucket.updatedAt))
    ? Number(bucket.updatedAt)
    : 0;
  return { pins, updatedAt, error };
}

/**
 * 写入某个 profile 的固定项（保留其他 profile 的桶）。
 *
 * 原子写：先写 `.tmp` 再 rename，避免中途崩溃留下半截 JSON
 * （下一条读到的就是「文件损坏」而不是「部分固定项」）。
 * @returns {{ok: boolean, pins: string[], updatedAt: number, error: string|null}}
 */
export function writePins(file, profile, pins, now = Date.now()) {
  const clean = normalizePins(pins);
  if (file === null) return { ok: false, pins: clean, updatedAt: 0, error: 'pins file path unresolved' };
  const { store } = readStore(file);
  const updatedAt = now;
  const next = {
    version: PINS_VERSION,
    profiles: { ...store.profiles, [profile]: { pins: clean, updatedAt } },
  };
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return { ok: true, pins: clean, updatedAt, error: null };
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 清 tmp 失败不影响结论 */
    }
    return { ok: false, pins: clean, updatedAt: 0, error: `cannot write pins file: ${error?.message ?? String(error)}` };
  }
}

/**
 * 「收纳结果 − 固定项」这条规则只实现一次，而且实现在浏览器半边（lib/client.js 的
 * effectiveHiddenIds）：因为固定/取消固定要立即反映到左侧栏，不能等宿主往返。
 * 宿主只负责持久化 pins 本身，不重复算一遍隐藏集合。
 */
