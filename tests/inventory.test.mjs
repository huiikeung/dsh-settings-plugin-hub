/**
 * dsh-settings-plugin-hub —— 宿主半边（安装来源识别）单元测试。
 *
 * 覆盖三层：
 *   1. 纯函数：spec 归类、bundle 里 settings.section id 提取、registrant 归一化、
 *      cordis.patch.yml 停用解析；
 *   2. 组合：在临时 profile 目录上跑 readProfileInventory + classifySections；
 *   3. 真机只读校验：对本机 /vol1/@appdata/deepseek.harness/dsh-data/profiles/web
 *      断言已知插件的来源判定（目录不存在时跳过）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  BUILTIN_SECTION_IDS,
  HUB_SECTION_ID,
  classifyInstallSpec,
  classifySections,
  collectedSectionIds,
  extractBundleId,
  extractSectionIds,
  parseDisabledIds,
  readProfileInventory,
  registrantCandidates,
  resolveDshHome,
  resolveProfileDir,
} from '../lib/inventory.js';

const REAL_PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? '/vol1/@appdata/deepseek.harness/dsh-data/profiles/web';
const tempDirs = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

describe('classifyInstallSpec', () => {
  it('把本地目录依赖判为 local', () => {
    for (const spec of [
      'link:/vol1/1000/x/dsh-a',
      'file:../dsh-b',
      '/abs/path/dsh-c',
      './rel/dsh-d',
      'workspace:*',
    ]) {
      assert.equal(classifyInstallSpec(spec).source, 'local', spec);
    }
  });

  it('把注册表 / git / tarball 依赖判为 remote', () => {
    for (const spec of [
      '^1.2.3',
      '1.2.3',
      '~0.4',
      'latest',
      '*',
      'github:A3Boy/dsh-web-tools#abc',
      'git+https://example.com/x.git',
      'git@github.com:me/x.git',
      'https://example.com/x.tgz',
      'npm:dsh-x@1.0.0',
    ]) {
      assert.equal(classifyInstallSpec(spec).source, 'remote', spec);
    }
  });

  it('空 spec 不算来源', () => {
    assert.equal(classifyInstallSpec('').source, 'unknown');
    assert.equal(classifyInstallSpec(undefined).source, 'unknown');
  });
});

describe('extractSectionIds', () => {
  it('读得出手写（未压缩）写法', () => {
    const source = `
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "better-display",
        order: 40,
        label: () => "界面增强"
      }, SettingsSection));
    `;
    assert.deepEqual(extractSectionIds(source), ['better-display']);
  });

  it('读得出压缩写法（同一行里 slot 字面量出现两次）', () => {
    const source = 'S(h,"settings.section",{name:"settings.section",id:"cost-meter",order:30,label:A},vs,!0);'
      + 'S(h,"settings.section",{name:"settings.section",id:"cost-meter-usage",order:31,label:B},Et,A);';
    assert.deepEqual(extractSectionIds(source), ['cost-meter', 'cost-meter-usage']);
  });

  it('窗口里夹着别的 settings.* slot 时放弃这次命中（宁漏不错）', () => {
    const source = 'k.inject("settings.section",()=>k.register({name:"settings.section",id:DYN},C));'
      + 'k.register({name:"settings.general.item",id:"cost-meter-usage",order:30},Et);';
    assert.deepEqual(extractSectionIds(source), []);
  });

  it('id 是常量标识符时回源码解析它的值（dsh-search 的真实写法）', () => {
    const source = 'const SECTION_ID = "web-tools";\n'
      + 'ctx.slots.inject("settings.section", () => ctx.slots.register({\n'
      + '  name: "settings.section",\n  id: SECTION_ID,\n  order: 30\n}, C));';
    assert.deepEqual(extractSectionIds(source), ['web-tools']);
  });

  it('常量解析不出来时宁可漏判也不猜', () => {
    // SECTION_ID 从未被赋过字符串值 → 提取为空，该分页落进「来源未识别」。
    const source = 'ctx.slots.register({name:"settings.section",id:SECTION_ID},C);';
    assert.deepEqual(extractSectionIds(source), []);
    // 常量被赋的是非字符串 → 同样不猜。
    const nonString = 'const SECTION_ID = compute();ctx.slots.register({name:"settings.section",id:SECTION_ID},C);';
    assert.deepEqual(extractSectionIds(nonString), []);
  });

  it('没有 settings.section 时返回空', () => {
    assert.deepEqual(extractSectionIds('const a = 1;'), []);
    assert.deepEqual(extractSectionIds(undefined), []);
  });
});

describe('extractBundleId', () => {
  it('读 __ModuleLoader__.load 的 id', () => {
    const source = 'window.__ModuleLoader__.load({\n\tid: "dsh-vision-assistant",\n\tfactory: (require) => {} });';
    assert.equal(extractBundleId(source), 'dsh-vision-assistant');
  });

  it('读不到时返回空串', () => {
    assert.equal(extractBundleId('no loader here'), '');
  });
});

describe('registrantCandidates', () => {
  it('覆盖实测到的四种 registrant 形态', () => {
    assert.ok(registrantCandidates('dsh-better-display-client').includes('dsh-better-display'));
    assert.ok(registrantCandidates('dsh-cool-theme/client').includes('dsh-cool-theme'));
    assert.ok(registrantCandidates('@dsh-plugin/dsh-auxiliary').includes('@dsh-plugin/dsh-auxiliary'));
    assert.ok(registrantCandidates('dsh-plugin-capabilities').includes('dsh-plugin-capabilities'));
  });

  it('空值返回空数组', () => {
    assert.deepEqual(registrantCandidates(''), []);
    assert.deepEqual(registrantCandidates(undefined), []);
  });
});

describe('parseDisabledIds', () => {
  it('读得出一条覆盖项里的 disabled: true', () => {
    const patch = [
      '- insert:',
      '    - id: settings-plugin-hub',
      "      name: 'dsh-settings-plugin-hub'",
      '- id: vision-opencode',
      '  disabled: true',
      '- id: usage-stats',
      '  disabled: false',
      '- id: mobile-gateway',
      '  disabled: true',
    ].join('\n');
    const disabled = parseDisabledIds(patch);
    assert.ok(disabled.has('vision-opencode'));
    assert.ok(disabled.has('mobile-gateway'));
    assert.ok(!disabled.has('usage-stats'));
    assert.ok(!disabled.has('settings-plugin-hub'));
  });
});

describe('resolveProfileDir', () => {
  it('优先使用显式 profileDir', () => {
    const dir = tempDir('hub-profile-');
    mkdirSync(join(dir, 'profiles', 'web'), { recursive: true });
    writeFileSync(join(dir, 'profiles', 'web', 'package.json'), '{}');
    assert.equal(resolveProfileDir({ profileDir: join(dir, 'profiles', 'web') }), join(dir, 'profiles', 'web'));
  });

  it('按 $DSH_HOME/profiles/<profile> 解析', () => {
    const home = tempDir('hub-home-');
    const target = join(home, 'profiles', 'web');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), '{}');
    assert.equal(resolveProfileDir({ env: { DSH_HOME: home }, profile: 'web' }), target);
  });
});

describe('resolveDshHome', () => {
  it('优先级：显式配置 > $DSH_HOME > ~/.dsh', () => {
    assert.equal(resolveDshHome({ dshHome: '/explicit', env: { DSH_HOME: '/env' }, home: '/home/me' }), '/explicit');
    assert.equal(resolveDshHome({ env: { DSH_HOME: '/env' }, home: '/home/me' }), '/env');
    assert.equal(resolveDshHome({ env: {}, home: '/home/me' }), '/home/me/.dsh');
  });

  it('空白值当作没设置', () => {
    assert.equal(resolveDshHome({ env: { DSH_HOME: '   ' }, home: '/home/me' }), '/home/me/.dsh');
  });

  it('三样都没有时返回 null（调用方据此放弃写盘，而不是写相对路径）', () => {
    assert.equal(resolveDshHome({ env: {}, home: undefined }), null);
  });

  it('不要求 profile 已存在（首启动就要能定位 plugin-data）', () => {
    const home = tempDir('hub-empty-home-');
    assert.equal(resolveDshHome({ env: { DSH_HOME: home } }), home);
  });
});

describe('readProfileInventory + classifySections', () => {
  /** 造一个「两个本地 link 包 + 两个远程包」的临时 profile。 */
  function buildFixtureProfile() {
    const root = tempDir('hub-fixture-');
    const profileDir = join(root, 'profiles', 'web');
    const sharedModules = join(root, 'profiles', 'node_modules');
    const localModules = join(profileDir, 'node_modules');
    mkdirSync(sharedModules, { recursive: true });
    mkdirSync(localModules, { recursive: true });

    // 本地包：源码目录在 profile 之外，node_modules 里是软链。
    const localSource = join(root, 'src', 'dsh-local-thing');
    mkdirSync(join(localSource, 'lib'), { recursive: true });
    writeFileSync(join(localSource, 'package.json'), JSON.stringify({
      name: 'dsh-local-thing',
      exports: { './client': './lib/client.js' },
      dsh: { client: { platform: 'web' }, bundle: { patch: './cordis.patch.yml' } },
    }));
    writeFileSync(join(localSource, 'lib', 'client.js'),
      'window.__ModuleLoader__.load({id:"dsh-local-thing",factory:()=>{ctx.slots.register({name:"settings.section",id:"local-thing",order:40},C)}});');
    writeFileSync(join(localSource, 'cordis.patch.yml'), "- insert:\n    - id: local-thing\n      name: 'dsh-local-thing'\n");
    symlinkSync(localSource, join(localModules, 'dsh-local-thing'), 'dir');

    // 远程包：真目录放在共享 node_modules 里（pnpm 的 <profiles>/node_modules 形态）。
    const remoteDir = join(sharedModules, 'dsh-remote-thing');
    mkdirSync(join(remoteDir, 'lib'), { recursive: true });
    writeFileSync(join(remoteDir, 'package.json'), JSON.stringify({
      name: 'dsh-remote-thing',
      main: 'lib/index.js',
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } },
    }));
    writeFileSync(join(remoteDir, 'lib', 'client.js'),
      'window.__ModuleLoader__.load({id:"dsh-remote-thing",factory:()=>{ctx.slots.register({name:"settings.section",id:"remote-thing",order:41},C)}});');

    // 两个包都声明同一个分页 id，其中一个被 profile patch 停用 —— 用来验证消歧。
    const shadowDir = join(sharedModules, 'dsh-shadow-thing');
    mkdirSync(join(shadowDir, 'lib'), { recursive: true });
    writeFileSync(join(shadowDir, 'package.json'), JSON.stringify({
      name: 'dsh-shadow-thing',
      exports: { './client': './lib/client.js' },
      dsh: { client: { platform: 'web' }, bundle: { patch: './cordis.patch.yml' } },
    }));
    writeFileSync(join(shadowDir, 'lib', 'client.js'),
      'window.__ModuleLoader__.load({id:"dsh-shadow-thing",factory:()=>{ctx.slots.register({name:"settings.section",id:"local-thing",order:40},C)}});');
    writeFileSync(join(shadowDir, 'cordis.patch.yml'), "- insert:\n    - id: shadow-thing\n      name: 'dsh-shadow-thing'\n");

    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {
        'dsh-local-thing': `link:${localSource}`,
        'dsh-remote-thing': '^1.2.3',
        'dsh-shadow-thing': '^2.0.0',
      },
      dsh: { profile: { bundles: ['dsh-local-thing', 'dsh-remote-thing', 'dsh-shadow-thing'] } },
    }));
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '# fixture\n- id: shadow-thing\n  disabled: true\n');
    return { root, profileDir, localSource };
  }

  it('把 link 包判为 local、注册表包判为 remote、软链逃逸也判为 local', () => {
    const { profileDir, localSource } = buildFixtureProfile();
    const inventory = readProfileInventory(profileDir);
    assert.equal(inventory.ok, true);
    const byName = new Map(inventory.packages.map((pkg) => [pkg.name, pkg]));
    assert.equal(byName.get('dsh-local-thing').source, 'local');
    assert.equal(byName.get('dsh-local-thing').symlinked, true);
    assert.equal(byName.get('dsh-remote-thing').source, 'remote');
    assert.deepEqual(byName.get('dsh-local-thing').sectionIds, ['local-thing']);
    assert.deepEqual(byName.get('dsh-local-thing').entryIds, ['local-thing']);
    // spec 里不回传机器绝对路径。
    assert.equal(byName.get('dsh-local-thing').spec, 'link:dsh-local-thing');
    assert.ok(!JSON.stringify(inventory).includes(localSource));
  });

  it('停用判定同时覆盖包名与 Loader 条目 id', () => {
    const { profileDir } = buildFixtureProfile();
    const inventory = readProfileInventory(profileDir);
    const shadow = inventory.packages.find((pkg) => pkg.name === 'dsh-shadow-thing');
    assert.equal(shadow.disabled, true, 'patch 用条目 id shadow-thing 停用，包名匹配不上也要判出停用');
  });

  it('分组：内置留在原地，第三方按来源落组，同 id 抢注时优先未停用/registrant 匹配的那个', () => {
    const { profileDir } = buildFixtureProfile();
    const inventory = readProfileInventory(profileDir);
    const sections = [
      { id: 'general', label: '通用', order: 0, registrant: 'ui-settings-general' },
      { id: 'models', label: '模型', order: 10, registrant: 'ui-settings-models' },
      { id: 'local-thing', label: '本地玩意', order: 40, registrant: 'dsh-local-thing-client' },
      { id: 'remote-thing', label: '远程玩意', order: 41, registrant: 'dsh-remote-thing' },
      { id: 'mystery-thing', label: '来历不明', order: 42, registrant: 'dsh-not-installed' },
      { id: HUB_SECTION_ID, label: '第三方插件', order: 1000, registrant: 'dsh-settings-plugin-hub-client' },
    ];
    const result = classifySections(sections, inventory);
    assert.deepEqual(result.builtin, ['general', 'models']);
    assert.deepEqual(result.groups.local.map((item) => item.id), ['local-thing']);
    assert.equal(result.groups.local[0].package, 'dsh-local-thing');
    assert.deepEqual(result.groups.remote.map((item) => item.id), ['remote-thing']);
    assert.deepEqual(result.groups.unknown.map((item) => item.id), ['mystery-thing']);
    assert.equal(result.groups.unknown[0].reason, 'no-installed-package-matched');
    // 收纳页自己不收纳自己。
    assert.ok(!collectedSectionIds(result).includes(HUB_SECTION_ID));
    assert.deepEqual(collectedSectionIds(result).sort(), ['local-thing', 'mystery-thing', 'remote-thing']);
  });

  it('官方内置分页即便没匹配到包也留在原地', () => {
    const result = classifySections(
      [{ id: 'archived-sessions', label: '归档会话', order: 25, registrant: 'ui-settings-unarchive-sessions' }],
      { packages: [] },
    );
    assert.deepEqual(result.builtin, ['archived-sessions']);
    assert.deepEqual(collectedSectionIds(result), []);
    assert.ok(BUILTIN_SECTION_IDS.includes('archived-sessions'));
  });
});

describe('真机 profile 只读校验', () => {
  it('本机 web profile 的来源与分页归属符合实际情况', { skip: !existsSync(join(REAL_PROFILE_DIR, 'package.json')) }, () => {
    const inventory = readProfileInventory(REAL_PROFILE_DIR);
    assert.equal(inventory.ok, true, inventory.error);
    const byName = new Map(inventory.packages.map((pkg) => [pkg.name, pkg]));

    // 本地 link 安装的插件
    for (const name of ['dsh-better-display', 'dsh-vision-assistant', 'dsh-my-plugins', 'dsh-settings-mobile-nav']) {
      const pkg = byName.get(name);
      assert.ok(pkg, `${name} 应在 profile 依赖里`);
      assert.equal(pkg.source, 'local', `${name} 是 link: 本地安装`);
    }
    // 远程安装的插件
    for (const name of ['dsh-cost-meter', 'dsh-mnemon', 'dshmarket', 'dsh-archived-chats']) {
      const pkg = byName.get(name);
      assert.ok(pkg, `${name} 应在 profile 依赖里`);
      assert.equal(pkg.source, 'remote', `${name} 是注册表安装`);
    }
    // 分页归属：vision 同时被 dsh-vision-assistant 与已停用的 dsh-vision-opencode 抢注
    assert.deepEqual(byName.get('dsh-vision-assistant').sectionIds, ['vision']);
    assert.equal(byName.get('dsh-vision-opencode').disabled, true);
    assert.deepEqual(byName.get('dsh-cost-meter').sectionIds, ['cost-meter', 'cost-meter-usage']);
    assert.deepEqual(byName.get('dsh-better-display').sectionIds, ['better-display']);

    const sections = [
      { id: 'general', label: '通用', order: 0, registrant: 'ui-settings-general' },
      { id: 'models', label: '模型', order: 10, registrant: 'ui-settings-models' },
      { id: 'vision', label: '视觉助手', order: 11, registrant: 'dsh-vision-assistant' },
      { id: 'plugins', label: '内置插件', order: 15, registrant: 'ui-settings-plugins' },
      { id: 'agent-presets', label: 'Agent 预设', order: 20, registrant: 'ui-agent-preset' },
      { id: 'archived-sessions', label: '归档会话', order: 25, registrant: 'ui-settings-unarchive-sessions' },
      { id: 'cost-meter', label: '用量', order: 30, registrant: 'dsh-cost-meter' },
      { id: 'better-display', label: '界面增强', order: 40, registrant: 'dsh-better-display-client' },
      { id: HUB_SECTION_ID, label: '第三方插件', order: 1000, registrant: 'dsh-settings-plugin-hub-client' },
    ];
    const result = classifySections(sections, inventory);
    assert.deepEqual(result.builtin.sort(), ['agent-presets', 'archived-sessions', 'general', 'models', 'plugins']);
    assert.deepEqual(result.groups.local.map((item) => item.id).sort(), ['better-display', 'vision']);
    assert.deepEqual(result.groups.remote.map((item) => item.id), ['cost-meter']);
    assert.deepEqual(result.groups.unknown, []);
  });

  it('真机回归：dsh-search 的分页 id 是常量变量（id: SECTION_ID = "web-tools"），也要归到本地', { skip: !existsSync('/vol1/1000/Deepseek-Harness/工作台/插件/dsh-search/lib/client.js') }, () => {
    const inventory = readProfileInventory(REAL_PROFILE_DIR);
    assert.equal(inventory.ok, true, inventory.error);
    const search = inventory.packages.find((pkg) => pkg.name === 'dsh-search');
    assert.deepEqual(search.sectionIds, ['web-tools'], '常量间接写法必须被解析出来');
    // registrant 无论是什么（该包客户端不导出 name，fiber 名不可控），
    // 只要分页 id 能对上包，就归本地 —— 这正是线上「网页搜索显示未知」的根因。
    const result = classifySections(
      [{ id: 'web-tools', label: '网页搜索', order: 30, registrant: 'some-unrelated-fiber-name' }],
      inventory,
    );
    assert.deepEqual(result.groups.local.map((item) => item.id), ['web-tools']);
    assert.equal(result.groups.local[0].package, 'dsh-search');
    assert.deepEqual(result.groups.unknown, []);
  });
});
