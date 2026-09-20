/**
 * dsh-settings-plugin-hub —— 安装来源识别（宿主半边纯逻辑）。
 *
 * 这一层只做两件事，且都不依赖 cordis：
 *
 * 1. 读「当前 web profile 装了哪些包、分别从哪里来」：
 *    package.json 的 dependencies 给出安装 spec（`link:` / `file:` = 本地目录，
 *    语义化版本 / `github:` / tarball = 远程），node_modules 的 realpath 作为
 *    第二判据（pnpm 把 link: 依赖物化成指向 profile 之外的软链）。
 * 2. 把浏览器上报的分页（settings.section 条目）与包对上：
 *    每个包的客户端 bundle 里出现的 `settings.section` id 就是该包注册的分页，
 *    包名 / bundle id / registrant 作为辅助判据。
 *
 * 刻意不返回任何绝对路径：DSH 的 web 端口可能被反向代理暴露到公网，
 * `link:/vol1/.../dsh-x` 这类 spec 里带着机器目录结构，一律折叠成 `link:dsh-x`。
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** 决定设置左侧栏分页的 slot（由 ui-settings-general 的 sidebar.settings 条目声明）。 */
export const SECTION_SLOT = 'settings.section';

/** 本插件自己的分页 id —— 永远不参与「收纳」，它是收纳后的唯一入口。 */
export const HUB_SECTION_ID = 'third-party-plugins';

/** DSH 内置包注册的设置分页 id。它们留在原生位置，不进收纳页。
 *  这些 id 来自 @deepseek-ai 官方包（ui-settings-general / -models / -plugins /
 *  ui-agent-preset / ui-settings-unarchive-sessions），改动时同步更新。 */
export const BUILTIN_SECTION_IDS = Object.freeze([
  'general',
  'models',
  'plugins',
  'agent-presets',
  'archived-sessions',
]);

/** 官方包的 scope/前缀，用于「没匹配上任何已安装包」时兜底判为内置。 */
const OFFICIAL_PREFIXES = Object.freeze(['@deepseek-ai/', 'dsh-client-', 'dsh-host-', 'dsh-api-', 'dsh-web-']);

/** 读取客户端 bundle 的上限，防止读到异常大的文件（正常 bundle 都在几 MB 内）。 */
const CLIENT_SOURCE_CAP = 8 * 1024 * 1024;

/**
 * 把一个依赖 spec 归类。
 * @param {unknown} spec - package.json 里的依赖值，例如 `link:/x/y`、`^1.2.3`。
 * @returns {{kind: string, source: 'local'|'remote'|'unknown'}}
 *   `local` = 来自本机目录（link/file/path/workspace），`remote` = 来自注册表或 git。
 */
export function classifyInstallSpec(spec) {
  const raw = typeof spec === 'string' ? spec.trim() : '';
  if (raw === '') return { kind: 'unknown', source: 'unknown' };
  const lower = raw.toLowerCase();
  if (lower.startsWith('link:')) return { kind: 'link', source: 'local' };
  if (lower.startsWith('file:')) return { kind: 'file', source: 'local' };
  if (lower.startsWith('workspace:')) return { kind: 'workspace', source: 'local' };
  if (lower.startsWith('portal:')) return { kind: 'portal', source: 'local' };
  if (lower.startsWith('npm:')) return { kind: 'registry', source: 'remote' };
  if (/^(github|gitlab|bitbucket|gist):/.test(lower)) return { kind: 'git', source: 'remote' };
  if (lower.startsWith('git+') || lower.startsWith('git://') || lower.startsWith('git@')) {
    return { kind: 'git', source: 'remote' };
  }
  if (/^https?:\/\//.test(lower)) return { kind: 'tarball', source: 'remote' };
  if (raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('~/') || isAbsolute(raw)) {
    return { kind: 'path', source: 'local' };
  }
  // 其余（^1.2.3 / 1.2.3 / ~1.2 / latest / * / next）一律按注册表依赖处理。
  return { kind: 'registry', source: 'remote' };
}

/**
 * 从客户端 bundle 源码里提取该包注册的 `settings.section` id。
 *
 * 兼容两种写法（打包与手写）：
 *   name: "settings.section",\n id: "better-display",
 *   S(h,"settings.section",{name:"settings.section",id:"cost-meter",...},vs,!0)
 *
 * 做法是逐个命中 slot 字面量，在其后 240 字符的窗口里取第一个 `id:`；
 * 若这段窗口里还夹着「别的 settings.* slot 字面量」，说明命中点属于另一个
 * 注册调用（同一个 bundle 里往往紧挨着多个 slot），直接放弃这次命中——
 * 宁可漏判（该分页落进「来源未识别」分组），也不要错判把别人的分页收走。
 * @param {string} source - 客户端 bundle 文本。
 * @returns {string[]} 去重排序后的分页 id。
 */
export function extractSectionIds(source) {
  const text = typeof source === 'string' ? source : '';
  const ids = new Set();
  const slot = /["']settings\.section["']/g;
  let match;
  while ((match = slot.exec(text)) !== null) {
    const window = text.slice(match.index, match.index + 240);
    const idMatch = /(?:^|[{,\s])id\s*:\s*["']([^"']{1,120})["']/.exec(window);
    if (idMatch === null) continue;
    const between = window.slice(0, idMatch.index);
    const others = between.match(/["']settings\.[a-z.]+["']/g) ?? [];
    if (others.some((literal) => !/settings\.section$/.test(literal.replace(/["']/g, '')))) continue;
    const id = idMatch[1];
    if (id === SECTION_SLOT || id.length === 0) continue;
    ids.add(id);
  }
  return [...ids].sort();
}

/**
 * 提取 bundle 的模块身份：`window.__ModuleLoader__.load({ id: "…" })`。
 * @param {string} source - 客户端 bundle 文本。
 * @returns {string} bundle id，取不到时为空串。
 */
export function extractBundleId(source) {
  const text = typeof source === 'string' ? source : '';
  const match = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{\s*id\s*:\s*["']([^"']+)["']/.exec(text);
  return match === null ? '' : match[1];
}

/**
 * 把其他插件注册时留下的 `registrant`（客户端 Loader 的 fiber 名）折成
 * 一组可用于匹配包名的候选字符串。
 *
 * 现实里 registrant 的形态很不统一，实测同一台机器上既有
 * `dsh-better-display-client`、`dsh-plugin-capabilities`，
 * 也有 `dsh-cool-theme/client`、`@dsh-plugin/dsh-auxiliary`。
 * @param {unknown} raw - entry.options.registrant。
 * @returns {string[]} 候选包名（保持顺序，去重）。
 */
export function registrantCandidates(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return [];
  const out = [];
  const push = (candidate) => {
    const clean = candidate.trim();
    if (clean.length > 0 && !out.includes(clean)) out.push(clean);
  };
  // 带 scope 的包名保留两段（@scope/name），否则只取第一段（dsh-x/client → dsh-x）。
  const base = value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0];
  push(value);
  push(base);
  for (const variant of [...out]) {
    const stripped = variant.replace(/[-_](client|web|plugin|browser|ui|host)$/i, '');
    push(stripped);
    if (!stripped.startsWith('@') && !stripped.startsWith('dsh-')) push(`dsh-${stripped}`);
  }
  return out;
}

/** 归一化用于宽松比较：小写、去 scope、去 dsh- 前缀、去分隔符。 */
function looseKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/^dsh[-_]/, '')
    .replace(/[-_.]/g, '');
}

/**
 * 解析 DSH 数据根目录（`profiles/` 与 `plugin-data/` 的父目录）。
 * 优先级：显式配置 → $DSH_HOME → ~/.dsh。与 resolveProfileDir 同一套优先级，
 * 区别是这里不要求 profile 已经存在（plugin-data 可能在首启动时就要写）。
 * @param {{dshHome?: string, env?: Record<string, string|undefined>, home?: string}} [options]
 * @returns {string|null}
 */
export function resolveDshHome(options = {}) {
  const explicit = typeof options.dshHome === 'string' ? options.dshHome.trim() : '';
  if (explicit !== '') return resolve(explicit);
  const env = options.env ?? process.env;
  const envHome = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (envHome !== '') return resolve(envHome);
  const home = options.home ?? env.HOME;
  if (typeof home === 'string' && home.trim() !== '') return resolve(join(home.trim(), '.dsh'));
  return null;
}

/**
 * 解析 profile 目录（package.json 所在目录）。
 * 优先级：显式配置 → $DSH_HOME/profiles/<profile> → ~/.dsh/profiles/<profile>。
 * @param {{profileDir?: string, profile?: string, env?: Record<string, string|undefined>, home?: string}} options
 * @returns {string|null} 绝对目录，或 null（无法确定时）。
 */
export function resolveProfileDir(options = {}) {
  const explicit = typeof options.profileDir === 'string' ? options.profileDir.trim() : '';
  if (explicit !== '') return resolve(explicit);
  const env = options.env ?? process.env;
  const profile = (typeof options.profile === 'string' && options.profile.trim()) || 'web';
  const roots = [];
  const envHome = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (envHome !== '') roots.push(resolve(envHome));
  const home = options.home ?? env.HOME;
  if (typeof home === 'string' && home.trim() !== '') roots.push(join(home.trim(), '.dsh'));
  for (const root of roots) {
    const candidate = join(root, 'profiles', profile);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return roots.length > 0 ? join(roots[0], 'profiles', profile) : null;
}

/** 解析 cordis.patch.yml 里 `- id: x` + `disabled: true` 形式的停用条目。 */
export function parseDisabledIds(patchText) {
  const disabled = new Set();
  const text = typeof patchText === 'string' ? patchText : '';
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const idMatch = /^\s*-\s+id\s*:\s*['"]?([^'"#\s]+)['"]?/.exec(line);
    if (idMatch !== null) {
      current = idMatch[1];
      continue;
    }
    if (current === null) continue;
    if (/^\s*-\s+id\s*:/.test(line)) continue;
    const disabledMatch = /^\s*disabled\s*:\s*(true|false)\b/i.exec(line);
    if (disabledMatch !== null) {
      if (disabledMatch[1].toLowerCase() === 'true') disabled.add(current);
      current = null;
      continue;
    }
    // 缩进回到同级或更浅（新列表项/新顶层键）时结束当前条目。
    if (/^\S/.test(line) || /^\s{0,2}\S/.test(line)) current = null;
  }
  return disabled;
}

/** 折叠 spec 里的本地绝对路径，只留包名。 */
function displaySpec(name, spec, kind) {
  if (kind === 'link' || kind === 'file' || kind === 'path') {
    const value = String(spec);
    const trimmed = value.replace(/^(link|file):/, '').replace(/\/+$/, '');
    return `${kind === 'path' ? 'path' : kind}:${trimmed.split('/').filter(Boolean).pop() ?? name}`;
  }
  return typeof spec === 'string' ? spec : '';
}

/** 找出包的客户端 bundle 入口（相对包目录）。 */
function clientEntryOf(manifest) {
  const exported = manifest?.exports?.['./client'];
  const fromExports = typeof exported === 'string' ? exported : exported?.default;
  const candidates = [
    typeof manifest?.dsh?.client?.entry === 'string' ? manifest.dsh.client.entry : undefined,
    typeof fromExports === 'string' ? fromExports : undefined,
    'lib/client.js',
    'client.js',
    'dist/client.js',
  ];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.length > 0) ?? null;
}

/** 判断 path 是否位于 root 之内（含 root 自身）。 */
function isInside(path, root) {
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
  return path === root || path.startsWith(normalizedRoot);
}

/**
 * 从包自带的 bundle patch 里读出它声明的 Loader 条目 id。
 *
 * bundle 挂载时 Loader 条目 id 通常比包名短（`dsh-vision-opencode` 包的条目 id 是
 * `vision-opencode`），而 profile 的 cordis.patch.yml 用条目 id 表达停用，
 * 所以停用判定必须同时覆盖「包名」与「条目 id」，否则会被停用包的分页误判。
 * @param {string} packageDir - 包目录。
 * @param {object|null} manifest - 包 manifest。
 * @returns {string[]} 条目 id。
 */
function entryIdsOf(packageDir, manifest) {
  const patchPath = manifest?.dsh?.bundle?.patch;
  if (typeof patchPath !== 'string' || patchPath.length === 0) return [];
  try {
    const file = join(packageDir, patchPath);
    if (!existsSync(file) || statSync(file).size > 512 * 1024) return [];
    const text = readFileSync(file, 'utf8');
    const ids = new Set();
    let pending = null;
    for (const line of text.split(/\r?\n/)) {
      const idMatch = /^\s*-\s+id\s*:\s*['"]?([^'"#\s]+)['"]?/.exec(line);
      if (idMatch !== null) {
        pending = idMatch[1];
        continue;
      }
      const nameMatch = /^\s*name\s*:\s*['"]?([^'"#\s]+)['"]?/.exec(line);
      if (nameMatch !== null && pending !== null && nameMatch[1] === manifest.name) ids.add(pending);
    }
    return [...ids];
  } catch {
    return [];
  }
}

/** 读取一个依赖包的事实。任何一步失败都不抛，降级为「信息不全」。 */
function describePackage(name, spec, profileDir, bundleSet, disabledIds) {
  const roots = [join(profileDir, 'node_modules'), join(dirname(profileDir), 'node_modules')];
  const specClass = classifyInstallSpec(spec);
  let packageDir = null;
  let nodeModulesRoot = null;
  for (const root of roots) {
    const candidate = join(root, name);
    if (existsSync(candidate)) {
      packageDir = candidate;
      nodeModulesRoot = root;
      break;
    }
  }
  let resolvedPath = null;
  let symlinked = false;
  if (packageDir !== null) {
    try {
      // lstatSync：statSync 会跟随软链，而「这里是不是软链」正是本地依赖的判据之一。
      symlinked = lstatSync(packageDir).isSymbolicLink();
      resolvedPath = realpathSync(packageDir);
    } catch {
      resolvedPath = null;
    }
  }
  // 第二判据：软链指向 node_modules 之外 ⇒ 本地目录依赖（pnpm 对 link:/file: 的物化形态）。
  const escapes = resolvedPath !== null && nodeModulesRoot !== null && !isInside(resolvedPath, nodeModulesRoot);
  const source = specClass.source === 'local' || escapes
    ? 'local'
    : specClass.source === 'remote' && packageDir === null && specClass.kind === 'unknown'
      ? 'unknown'
      : 'remote';

  let manifest = null;
  if (packageDir !== null) {
    try {
      manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    } catch {
      manifest = null;
    }
  }
  const clientEntry = manifest === null ? null : clientEntryOf(manifest);
  const entryIds = manifest === null || packageDir === null ? [] : entryIdsOf(resolvedPath ?? packageDir, manifest);
  let sectionIds = [];
  let bundleId = '';
  if (clientEntry !== null && packageDir !== null) {
    try {
      const file = join(resolvedPath ?? packageDir, clientEntry);
      if (existsSync(file) && statSync(file).size <= CLIENT_SOURCE_CAP) {
        const text = readFileSync(file, 'utf8');
        sectionIds = extractSectionIds(text);
        bundleId = extractBundleId(text);
      }
    } catch {
      sectionIds = [];
    }
  }
  const hasClient = clientEntry !== null && (manifest?.dsh?.client !== undefined || manifest?.exports?.['./client'] !== undefined);
  const disabled = disabledIds.has(name) || entryIds.some((id) => disabledIds.has(id));
  return {
    name,
    spec: displaySpec(name, spec, specClass.kind),
    kind: specClass.kind,
    source,
    present: packageDir !== null,
    symlinked,
    bundle: bundleSet.has(name),
    disabled,
    entryIds,
    hasClient,
    sectionIds,
    bundleId,
  };
}

/**
 * 读取整个 profile 的插件清单（只读快照）。
 * @param {string|null} profileDir - profile 目录。
 * @returns {{ok: boolean, error?: string, profileDir?: string|null, packages: Array<object>, bundles: string[], disabled: string[]}}
 */
export function readProfileInventory(profileDir) {
  const empty = { ok: false, packages: [], bundles: [], disabled: [] };
  if (typeof profileDir !== 'string' || profileDir.trim() === '') {
    return { ...empty, error: 'profile directory unresolved', profileDir: null };
  }
  const dir = resolve(profileDir);
  const packageFile = join(dir, 'package.json');
  if (!existsSync(packageFile)) {
    return { ...empty, error: `profile package.json not found under ${dir}`, profileDir: dir };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(packageFile, 'utf8'));
  } catch (error) {
    return { ...empty, error: `invalid profile package.json: ${error?.message ?? String(error)}`, profileDir: dir };
  }
  const dependencies = manifest?.dependencies !== null && typeof manifest?.dependencies === 'object'
    ? manifest.dependencies
    : {};
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((entry) => typeof entry === 'string')
    : [];
  const bundleSet = new Set(bundles);
  let disabledIds = new Set();
  try {
    const patchFile = join(dir, 'cordis.patch.yml');
    if (existsSync(patchFile)) disabledIds = parseDisabledIds(readFileSync(patchFile, 'utf8'));
  } catch {
    disabledIds = new Set();
  }
  const packages = Object.keys(dependencies)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => describePackage(name, dependencies[name], dir, bundleSet, disabledIds));
  return { ok: true, profileDir: dir, packages, bundles, disabled: [...disabledIds] };
}

/** 在候选包中挑出某个分页的归属包。 */
function pickOwner(idHits, candidates, byCandidate) {
  if (idHits.length > 0) {
    const byRegistrant = idHits.find((pkg) => candidates.some((candidate) => (
      candidate === pkg.name || looseKey(candidate) === looseKey(pkg.name)
    )));
    if (byRegistrant !== undefined) return byRegistrant;
    const live = idHits.filter((pkg) => !pkg.disabled);
    if (live.length === 1) return live[0];
    const bundled = idHits.filter((pkg) => pkg.bundle && !pkg.disabled);
    if (bundled.length === 1) return bundled[0];
  }
  for (const candidate of candidates) {
    const hit = byCandidate.get(candidate) ?? byCandidate.get(looseKey(candidate));
    if (hit !== undefined) return hit;
  }
  if (idHits.length === 1) return idHits[0];
  return undefined;
}

/**
 * 把浏览器上报的分页逐条判定为：内置（留在原生位置）/ 本地安装 / 非本地安装 / 来源未识别。
 * @param {Array<{id: string, label?: string, order?: number, registrant?: string}>} sections
 * @param {{packages?: Array<object>}} inventory
 * @returns {{builtin: string[], groups: {local: object[], remote: object[], unknown: object[]}, owners: Record<string, string>}}
 */
export function classifySections(sections, inventory) {
  const packages = Array.isArray(inventory?.packages) ? inventory.packages : [];
  const bySectionId = new Map();
  for (const pkg of packages) {
    for (const id of pkg.sectionIds ?? []) {
      const list = bySectionId.get(id) ?? [];
      list.push(pkg);
      bySectionId.set(id, list);
    }
  }
  const byCandidate = new Map();
  for (const pkg of packages) {
    byCandidate.set(pkg.name, pkg);
    byCandidate.set(looseKey(pkg.name), pkg);
    byCandidate.set(basename(pkg.name), pkg);
    for (const entryId of pkg.entryIds ?? []) {
      byCandidate.set(entryId, pkg);
      byCandidate.set(looseKey(entryId), pkg);
    }
    if (typeof pkg.bundleId === 'string' && pkg.bundleId !== '') {
      byCandidate.set(pkg.bundleId, pkg);
      byCandidate.set(looseKey(pkg.bundleId), pkg);
    }
  }

  const groups = { local: [], remote: [], unknown: [] };
  const builtin = [];
  const owners = {};
  const list = Array.isArray(sections) ? sections : [];
  for (const raw of list) {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    if (id === '' || id === HUB_SECTION_ID) continue;
    const label = typeof raw?.label === 'string' && raw.label.length > 0 ? raw.label : id;
    const order = Number.isFinite(raw?.order) ? Number(raw.order) : 0;
    const registrant = typeof raw?.registrant === 'string' ? raw.registrant : '';
    const candidates = registrantCandidates(registrant);
    const owner = pickOwner(bySectionId.get(id) ?? [], candidates, byCandidate);
    const ownerIsOfficial = owner !== undefined && OFFICIAL_PREFIXES.some((prefix) => owner.name.startsWith(prefix));
    if (BUILTIN_SECTION_IDS.includes(id) || ownerIsOfficial
      || (owner === undefined && OFFICIAL_PREFIXES.some((prefix) => registrant.startsWith(prefix)))) {
      builtin.push(id);
      continue;
    }
    const item = {
      id,
      label,
      order,
      registrant,
      package: owner?.name ?? '',
      spec: owner?.spec ?? '',
      bundle: owner?.bundle === true,
      disabled: owner?.disabled === true,
      reason: owner === undefined ? 'no-installed-package-matched' : 'matched',
    };
    if (owner === undefined) {
      groups.unknown.push(item);
      continue;
    }
    owners[id] = owner.name;
    if (owner.source === 'local') groups.local.push(item);
    else if (owner.source === 'remote') groups.remote.push(item);
    else groups.unknown.push(item);
  }
  const sorter = (a, b) => (a.order - b.order) || a.label.localeCompare(b.label);
  groups.local.sort(sorter);
  groups.remote.sort(sorter);
  groups.unknown.sort(sorter);
  return { builtin, groups, owners };
}

/** 所有需要从左侧栏收纳（隐藏）的分页 id。 */
export function collectedSectionIds(classification) {
  const groups = classification?.groups ?? {};
  return [...(groups.local ?? []), ...(groups.remote ?? []), ...(groups.unknown ?? [])]
    .map((item) => item.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
}
