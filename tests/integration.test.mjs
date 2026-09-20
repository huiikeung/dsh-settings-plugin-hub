/**
 * dsh-settings-plugin-hub —— 两个半边的对接测试（真 HTTP 语义、假 DOM、临时磁盘）。
 *
 * 各半边自己的单测都只验证「我以为对面要什么」。这里让浏览器的 fetch 直接打到
 * 宿主真正的 handler 上，覆盖三件单侧测不到的事：
 *   1. 端点路径 / 动作头 / 请求体字段名两边对得上；
 *   2. 「固定」之后文件真的落到磁盘；
 *   3. 重新加载（拿新那份 resolve 应答）后固定项仍在，左侧栏依旧是固定后的样子。
 */
import strict from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { apply as applyHost } from '../lib/index.js';
import { createSettingsDialog } from './fake-dom.mjs';
import { loadClientBundle } from './load-client.mjs';

/**
 * 浏览器半边跑在 vm 的独立 realm 里，它创建的数组/对象原型与宿主不同，
 * deepEqual 会因原型不等而报错 —— 比较前统一转成宿主侧普通值。
 */
const toPlain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const assert = {
  equal: (actual, expected, message) => strict.equal(actual, expected, message),
  notEqual: (actual, expected, message) => strict.notEqual(actual, expected, message),
  ok: (value, message) => strict.ok(value, message),
  match: (value, pattern, message) => strict.match(value, pattern, message),
  deepEqual: (actual, expected, message) => strict.deepEqual(toPlain(actual), toPlain(expected), message),
};

const REAL_PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? '/vol1/@appdata/deepseek.harness/dsh-data/profiles/web';
const hasProfile = existsSync(join(REAL_PROFILE_DIR, 'package.json'));
const rootDataDir = mkdtempSync(join(tmpdir(), 'hub-integration-'));

after(() => {
  rmSync(rootDataDir, { recursive: true, force: true });
});

/** 左侧栏账本（与真实机器上的形状一致：5 个内置 + 2 个第三方 + 本插件自己的入口）。 */
const LEDGER = [
  { options: { id: 'general', label: () => '通用', order: 0, registrant: 'ui-settings-general' } },
  { options: { id: 'models', label: () => '模型', order: 10, registrant: 'ui-settings-models' } },
  { options: { id: 'vision', label: () => '视觉助手', order: 11, registrant: 'dsh-vision-assistant' } },
  { options: { id: 'plugins', label: () => '内置插件', order: 15, registrant: 'ui-settings-plugins' } },
  { options: { id: 'agent-presets', label: () => 'Agent 预设', order: 20, registrant: 'ui-agent-preset' } },
  { options: { id: 'archived-sessions', label: () => '归档会话', order: 25, registrant: 'ui-settings-unarchive-sessions' } },
  { options: { id: 'cost-meter', label: () => '用量计费', order: 30, registrant: 'dsh-cost-meter' } },
  { options: { id: 'better-display', label: () => '界面增强', order: 40, registrant: 'dsh-better-display-client' } },
  { options: { id: 'third-party-plugins', label: () => '第三方插件', order: 1000, registrant: 'dsh-settings-plugin-hub-client' } },
];

const DOM_ROWS = LEDGER.map((entry) => ({ label: entry.options.label() }));

const ACTION_HEADER = 'x-settings-plugin-hub-action';

/** 按 host-route 测试同款方式把宿主插件挂到最小 cordis 上下文上。 */
function mountHost(dataDir) {
  const routes = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    inject(deps, cb) {
      cb({
        effect(fn) {
          fn();
        },
        webServer: {
          register(spec) {
            routes.set(spec.path, spec);
            return () => routes.delete(spec.path);
          },
        },
      });
    },
  };
  applyHost(ctx, {
    config: { profile: 'web', dataDir, ...(hasProfile ? { profileDir: REAL_PROFILE_DIR } : {}) },
  });
  return routes;
}

/** 把 fetch(url, init) 转发给宿主真实 handler，返回 {status, json()}。 */
function bridgeFetch(routes) {
  return (url, init = {}) => {
    const route = routes.get(url);
    if (route === undefined) return Promise.reject(new Error(`no route for ${url}`));
    const request = asyncIteratorOf(init.body ?? '');
    request.method = init.method ?? 'GET';
    request.headers = init.headers ?? {};
    return new Promise((resolve, reject) => {
      const chunks = [];
      const response = {
        status: 0,
        writeHead(status) {
          this.status = status;
        },
        end(payload) {
          if (payload !== undefined) chunks.push(Buffer.from(payload));
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: this.status,
            json: () => Promise.resolve(JSON.parse(text)),
            text: () => Promise.resolve(text),
          });
        },
      };
      Promise.resolve(route.handler(request, response)).catch(reject);
    });
  };
}

function asyncIteratorOf(text) {
  const buffer = Buffer.from(text, 'utf8');
  let sent = false;
  return {
    async *[Symbol.asyncIterator]() {
      if (!sent) {
        sent = true;
        yield buffer;
      }
    },
  };
}

/** 造一个连着真实宿主的浏览器半边实例。 */
function bootClient(routes) {
  const { document, buttons } = createSettingsDialog(DOM_ROWS);
  const intervals = new Map();
  let nextId = 1;
  const window = {
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
    },
  };
  const loaded = loadClientBundle({ document, window, fetchImpl: bridgeFetch(routes) });
  const disposers = [];
  const scope = {
    slots: {
      entries: () => LEDGER,
      subscribe: () => () => {},
      inject: (name, factory) => factory(),
      register: () => () => {},
    },
    effect: (fn) => disposers.push(fn()),
  };
  const ctx = {
    inject: (deps, cb) => cb(scope),
    effect: (fn) => disposers.push(fn()),
  };
  loaded.exports.apply(ctx);
  return { api: loaded.exports.__internals, buttons, document, disposers };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 把收纳页组件树摊成文本（函数组件就地求值；数组是 createElement 的常见子节点形态）。 */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (typeof node.type === 'function') return collectText(node.type(node.props ?? {}), out);
  for (const child of node.children ?? []) collectText(child, out);
  return out;
}

const renderText = (api) => collectText(api.HubSection()).join(' | ');

/** 一次「重开设置弹窗」：同样的 DOM 结构，但走一遍全新的 resolve。 */
async function resolveAgain(api) {
  api.resolveNow({ slots: { entries: () => LEDGER } });
  await settle();
}

describe('两端对接 + 固定项持久化', { skip: !hasProfile }, () => {
  it('resolve → 收纳 → 固定 → 落盘 → 重新加载后依旧固定', async () => {
    const dataDir = join(rootDataDir, 'case-persist');
    const routes = mountHost(dataDir);
    const first = bootClient(routes);
    await settle();

    const hidden = (label) => first.buttons[DOM_ROWS.findIndex((row) => row.label === label)].style.display;
    assert.equal(first.api.getState().status, 'ready', first.api.getState().error);

    // 1. 第三方分页被收纳，内置的留在原地
    assert.equal(hidden('视觉助手'), 'none');
    assert.equal(hidden('界面增强'), 'none');
    assert.equal(hidden('用量计费'), 'none');
    for (const label of ['通用', '模型', '内置插件', 'Agent 预设', '归档会话']) {
      assert.notEqual(hidden(label), 'none', `${label} 是内置分页，必须留在左侧栏`);
    }
    assert.notEqual(hidden('第三方插件'), 'none', '收纳入口自己不能被藏');

    // 2. 固定「视觉助手」→ 立即回左侧栏，并且真的写进磁盘
    first.api.togglePinned('vision');
    assert.notEqual(hidden('视觉助手'), 'none', '固定后立刻显示');
    assert.equal(hidden('界面增强'), 'none', '没固定的照旧收着');
    await settle();
    assert.equal(first.api.getState().pinsError, '', first.api.getState().pinsError);

    const pinsFile = join(dataDir, 'plugin-data', 'dsh-settings-plugin-hub', 'pins.json');
    assert.ok(existsSync(pinsFile), '固定项必须落盘');
    const onDisk = JSON.parse(readFileSync(pinsFile, 'utf8'));
    assert.deepEqual(onDisk.profiles.web.pins, ['vision']);
    assert.equal(existsSync(`${pinsFile}.tmp`), false, '原子写不留 .tmp');

    // 3. 模拟「重启 / 换一个浏览器」：全新实例，只读宿主持久化的固定项
    for (const dispose of first.disposers) {
      if (typeof dispose === 'function') dispose();
    }
    const second = bootClient(routes);
    await settle();
    const snapshot = second.api.getState();
    assert.deepEqual(snapshot.pins, ['vision']);
    assert.notEqual(second.buttons[2].style.display, 'none', '重启后固定项仍生效');
    assert.equal(second.buttons[7].style.display, 'none', '其余照旧收纳');
    assert.match(renderText(second.api), /固定在左侧栏显示 · 1/, '重启后「固定」区域照常出现');

    // 4. 取消固定 → 立刻收走、文件同步、整块「固定」区域随之隐藏
    second.api.togglePinned('vision');
    assert.equal(second.buttons[2].style.display, 'none');
    const afterUnpin = renderText(second.api);
    assert.ok(!afterUnpin.includes('固定在左侧栏显示'), '计数归 0 后整块隐藏');
    assert.ok(!afterUnpin.includes('固定设置已保存'), '「已保存」状态行也一起隐藏');
    await settle();
    assert.deepEqual(JSON.parse(readFileSync(pinsFile, 'utf8')).profiles.web.pins, []);
    assert.ok(!renderText(second.api).includes('固定在左侧栏显示'));
  });

  it('临时显示全部分页：固定项不变、不写盘，恢复收纳后固定项仍然单独显示', async () => {
    const dataDir = join(rootDataDir, 'case-showall');
    const routes = mountHost(dataDir);
    const { api, buttons, disposers } = bootClient(routes);
    await settle();

    await (async () => {
      api.togglePinned('better-display');
      await settle();
      assert.deepEqual(api.getState().pins, ['better-display']);

      api.setState({ showAll: true });
      api.applyRail();
      for (const label of DOM_ROWS.map((row) => row.label)) {
        assert.notEqual(buttons[DOM_ROWS.findIndex((row) => row.label === label)].style.display, 'none', `${label} 应临时全部显示`);
      }
      assert.deepEqual(api.getState().pins, ['better-display'], '临时开关不动固定项');

      api.setState({ showAll: false });
      api.applyRail();
      assert.notEqual(buttons[7].style.display, 'none', '固定项恢复后仍单独显示');
      assert.equal(buttons[2].style.display, 'none', '未固定的重新收纳');
      api.togglePinned('better-display');
      await settle();
    })();

    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose();
    }
  });
});
