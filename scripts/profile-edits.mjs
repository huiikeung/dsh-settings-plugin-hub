// dsh-settings-plugin-hub —— profile 改动的单一实现（install-profile.mjs / rollback-profile.mjs 共用）
//
// 为什么单独放一个文件：回滚要判断「当前文件是否仍处于安装后的状态」，
// 就必须能重算出「安装后应当长什么样」。把变换逻辑写两份迟早会漂移。

/** 本插件包名（= profile package.json 的依赖名 = dsh.profile.bundles 里的条目）。 */
export const PACKAGE_NAME = 'dsh-settings-plugin-hub';

/** bundle 列表里把本插件放到最后：bundle 逐个叠加 patch，放最后 = 最后覆盖。
 *  本插件只 insert 一个自己的 Loader 条目，不与任何插件争夺 id。 */
export function withBundle(bundles, name = PACKAGE_NAME) {
  const next = Array.isArray(bundles) ? [...bundles] : [];
  if (!next.includes(name)) next.push(name);
  return next;
}

/** 「安装后的 package.json 文本」。 */
export function installedPackageJson(preInstallText, pluginDir, name = PACKAGE_NAME) {
  const pkg = JSON.parse(preInstallText);
  pkg.dependencies ??= {};
  pkg.dependencies[name] = `link:${pluginDir}`;
  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  pkg.dsh.profile.bundles = withBundle(pkg.dsh.profile.bundles, name);
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** 当前内容是否仍是「安装后」状态（否则说明安装之后还有别的改动，回滚不能整文件覆盖）。 */
export function isInstalledPackageJson(currentText, preInstallText, pluginDir, name = PACKAGE_NAME) {
  try {
    return currentText === installedPackageJson(preInstallText, pluginDir, name);
  } catch {
    return false;
  }
}

/** 反向撤销 package.json：只摘掉本插件加的东西。返回 null 表示无需改动。 */
export function stripPackageJson(currentText, name = PACKAGE_NAME) {
  const pkg = JSON.parse(currentText);
  let changed = false;
  if (pkg.dependencies && name in pkg.dependencies) {
    delete pkg.dependencies[name];
    changed = true;
  }
  const bundles = pkg.dsh?.profile?.bundles;
  if (Array.isArray(bundles) && bundles.includes(name)) {
    pkg.dsh.profile.bundles = bundles.filter((entry) => entry !== name);
    changed = true;
  }
  return changed ? `${JSON.stringify(pkg, null, 2)}\n` : null;
}
