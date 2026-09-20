/**
 * dsh-settings-plugin-hub —— 宿主插件端到端测试。
 *
 * 不 mock handler 本身：用一个最小 cordis 上下文把 lib/index.js 的 apply 跑起来，
 * 拿它注册的真实 handler 挂到 node:http 上，再打真请求。覆盖动作头、方法、
 * 请求体上限、真实 profile 的分组结果，以及「固定在左侧栏显示」白名单的读写。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { apply } from '../lib/index.js';

const REAL_PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? '/vol1/@appdata/deepseek.harness/dsh-data/profiles/web';
const ACTION_HEADER = 'x-settings-plugin-hub-action';
const hasProfile = existsSync(join(REAL_PROFILE_DIR, 'package.json'));

/** pins 有写操作，测试必须把 dataDir 指到临时目录，绝不能碰真实 $DSH_HOME。 */
const dataDir = mkdtempSync(join(tmpdir(), 'hub-route-data-'));

let server;
let baseUrl;
let closers = [];

/** 把 apply 挂到最小 cordis 上下文上，返回注册到的路由表。 */
function mountHostPlugin(config) {
  const routes = new Map();
  const effects = [];
  const webServer = {
    register(spec) {
      routes.set(spec.path, spec);
      return () => routes.delete(spec.path);
    },
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    inject(deps, cb) {
      assert.equal(Array.from(deps).join(','), 'webServer');
      cb({
        effect(fn, label) {
          assert.equal(typeof label, 'string');
          effects.push(fn());
        },
        webServer,
      });
    },
  };
  apply(ctx, { config });
  return { routes, effects };
}

before(async () => {
  const { routes } = mountHostPlugin({
    profile: 'web',
    dataDir,
    ...(hasProfile ? { profileDir: REAL_PROFILE_DIR } : { profileDir: '/nonexistent-profile-dir' }),
  });
  server = createServer((req, res) => {
    const route = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    if (route === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  closers = [];
});

after(async () => {
  for (const close of closers) close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

const url = (path) => `${baseUrl}${path}`;

describe('宿主端点 /settings-plugin-hub', () => {
  it('缺动作头一律 403（webServer 路由没有浏览器会话鉴权）', async () => {
    const inventory = await fetch(url('/settings-plugin-hub/inventory'));
    assert.equal(inventory.status, 403);
    const resolve = await fetch(url('/settings-plugin-hub/resolve'), { method: 'POST', body: '{}' });
    assert.equal(resolve.status, 403);
    const pins = await fetch(url('/settings-plugin-hub/pins'));
    assert.equal(pins.status, 403);
    const put = await fetch(url('/settings-plugin-hub/pins'), { method: 'PUT', body: '{"pins":[]}' });
    assert.equal(put.status, 403);
  });

  it('方法不符 405 且带 Allow', async () => {
    const posted = await fetch(url('/settings-plugin-hub/inventory'), {
      method: 'POST',
      headers: { [ACTION_HEADER]: 'inventory' },
    });
    assert.equal(posted.status, 405);
    assert.equal(posted.headers.get('allow'), 'GET');
    const got = await fetch(url('/settings-plugin-hub/resolve'), { headers: { [ACTION_HEADER]: 'resolve' } });
    assert.equal(got.status, 405);
    assert.equal(got.headers.get('allow'), 'POST');
    const deleted = await fetch(url('/settings-plugin-hub/pins'), { method: 'DELETE', headers: { [ACTION_HEADER]: 'pins' } });
    assert.equal(deleted.status, 405);
    assert.equal(deleted.headers.get('allow'), 'GET, PUT');
  });

  it('inventory 返回包来源，且不泄漏机器绝对路径', { skip: !hasProfile }, async () => {
    const response = await fetch(url('/settings-plugin-hub/inventory'), { headers: { [ACTION_HEADER]: 'inventory' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.ok, true, body.error);
    assert.equal(body.profile, 'web');
    const byName = new Map(body.packages.map((pkg) => [pkg.name, pkg]));
    assert.equal(byName.get('dsh-better-display').source, 'local');
    assert.equal(byName.get('dsh-cost-meter').source, 'remote');
    assert.equal(byName.get('dsh-better-display').spec, 'link:dsh-better-display');
    assert.ok(!JSON.stringify(body).includes(REAL_PROFILE_DIR), '应答里不应出现 profile 绝对路径');
    assert.ok(!JSON.stringify(body).includes('/vol1/1000/Deepseek-Harness'), '应答里不应出现本地插件目录');
  });

  it('resolve 按分页 id 归组', { skip: !hasProfile }, async () => {
    const sections = [
      { id: 'general', label: '通用', order: 0, registrant: 'ui-settings-general' },
      { id: 'models', label: '模型', order: 10, registrant: 'ui-settings-models' },
      { id: 'vision', label: '视觉助手', order: 11, registrant: 'dsh-vision-assistant' },
      { id: 'plugins', label: '内置插件', order: 15, registrant: 'ui-settings-plugins' },
      { id: 'cost-meter', label: '用量', order: 30, registrant: 'dsh-cost-meter' },
      { id: 'better-display', label: '界面增强', order: 40, registrant: 'dsh-better-display-client' },
      { id: 'third-party-plugins', label: '第三方插件', order: 1000, registrant: 'dsh-settings-plugin-hub-client' },
    ];
    const response = await fetch(url('/settings-plugin-hub/resolve'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'resolve' },
      body: JSON.stringify({ sections }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.builtin.sort(), ['general', 'models', 'plugins']);
    assert.deepEqual(body.groups.local.map((item) => item.id).sort(), ['better-display', 'vision']);
    assert.deepEqual(body.groups.remote.map((item) => item.id), ['cost-meter']);
    assert.deepEqual(body.groups.unknown, []);
    assert.deepEqual(body.hiddenIds.sort(), ['better-display', 'cost-meter', 'vision']);
    assert.ok(!body.hiddenIds.includes('third-party-plugins'));
    // hiddenIds 是「应被收纳的全集」；减去 pins 由浏览器半边完成（固定/取消要立即生效，
    // 不能等一次往返）。这里只保证固定项随 resolve 一起下发。
    assert.deepEqual(body.pins, []);
    assert.equal(body.pinsError, null);
  });

  it('resolve 会带上已保存的固定项（hiddenIds 仍是收纳全集）', { skip: !hasProfile }, async () => {
    const put = await fetch(url('/settings-plugin-hub/pins'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'pins' },
      body: JSON.stringify({ pins: ['vision'] }),
    });
    assert.equal(put.status, 200);
    const response = await fetch(url('/settings-plugin-hub/resolve'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'resolve' },
      body: JSON.stringify({
        sections: [
          { id: 'vision', label: '视觉助手', order: 11, registrant: 'dsh-vision-assistant' },
          { id: 'cost-meter', label: '用量', order: 30, registrant: 'dsh-cost-meter' },
        ],
      }),
    });
    const body = await response.json();
    assert.deepEqual(body.pins, ['vision']);
    assert.deepEqual(body.hiddenIds.sort(), ['cost-meter', 'vision']);
    // 复位，避免影响后续用例
    await fetch(url('/settings-plugin-hub/pins'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'pins' },
      body: JSON.stringify({ pins: [] }),
    });
  });

  it('pins：读 → 写 → 再读，脏数据被收敛', async () => {
    const initial = await fetch(url('/settings-plugin-hub/pins'), { headers: { [ACTION_HEADER]: 'pins' } });
    assert.equal(initial.status, 200);
    const initialBody = await initial.json();
    assert.equal(initialBody.ok, true, initialBody.error);
    assert.equal(initialBody.profile, 'web');
    assert.equal(initialBody.file, 'plugin-data/dsh-settings-plugin-hub/pins.json');
    assert.ok(Array.isArray(initialBody.pins));

    const put = await fetch(url('/settings-plugin-hub/pins'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'pins' },
      body: JSON.stringify({ pins: [' vision ', 'cool-theme', 'vision', '', 42, null] }),
    });
    assert.equal(put.status, 200);
    const written = await put.json();
    assert.equal(written.ok, true, written.error);
    assert.deepEqual(written.pins, ['vision', 'cool-theme']);
    assert.equal(written.dropped, 4, '重复/空串/非字符串（42、null）共 4 条被忽略');
    assert.ok(written.updatedAt > 0);

    const again = await fetch(url('/settings-plugin-hub/pins'), { headers: { [ACTION_HEADER]: 'pins' } });
    const againBody = await again.json();
    assert.deepEqual(againBody.pins, ['vision', 'cool-theme']);

    const cleared = await fetch(url('/settings-plugin-hub/pins'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'pins' },
      body: JSON.stringify({ pins: [] }),
    });
    assert.deepEqual((await cleared.json()).pins, []);
  });

  it('pins：形状不对 400，超量被截断', async () => {
    const bad = await fetch(url('/settings-plugin-hub/pins'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'pins' },
      body: JSON.stringify({ pins: 'vision' }),
    });
    assert.equal(bad.status, 400);
    const missing = await fetch(url('/settings-plugin-hub/pins'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'pins' },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
    const malformed = await fetch(url('/settings-plugin-hub/pins'), {
      method: 'PUT',
      headers: { [ACTION_HEADER]: 'pins' },
      body: '{oops',
    });
    assert.equal(malformed.status, 400);

    const many = Array.from({ length: 320 }, (_, index) => `sec-${index}`);
    const put = await fetch(url('/settings-plugin-hub/pins'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'pins' },
      body: JSON.stringify({ pins: many }),
    });
    const body = await put.json();
    assert.equal(body.pins.length, 200);
    assert.equal(body.pins[0], 'sec-0');
    await fetch(url('/settings-plugin-hub/pins'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'pins' },
      body: JSON.stringify({ pins: [] }),
    });
  });

  it('pins 按 profile 分桶，互不干扰', async () => {
    const { routes } = mountHostPlugin({ profile: 'other', profileDir: REAL_PROFILE_DIR, dataDir });
    const result = await callHandler(routes.get('/settings-plugin-hub/pins').handler, {
      method: 'GET',
      headers: { [ACTION_HEADER]: 'pins' },
      body: '',
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.pins, [], 'other profile 不该看到 web profile 的固定项');
    assert.equal(result.body.profile, 'other');
  });

  it('写不进去时 500 且如实报错（不抛给宿主）', async () => {
    // 用一个「文件」当目录用，制造 ENOTDIR。
    const blocker = join(dataDir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const { routes } = mountHostPlugin({ profile: 'web', profileDir: REAL_PROFILE_DIR, dataDir: blocker });
    const result = await callHandler(routes.get('/settings-plugin-hub/pins').handler, {
      method: 'PUT',
      headers: { [ACTION_HEADER]: 'pins', 'content-type': 'application/json' },
      body: JSON.stringify({ pins: ['vision'] }),
    });
    assert.equal(result.status, 500);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /cannot write pins file/);
    // 读不到文件本身不是错误（全新安装就是「没有文件 = 没有固定项」），
    // 所以写失败只从写应答暴露，读应答仍是空列表。
    const read = await callHandler(routes.get('/settings-plugin-hub/pins').handler, {
      method: 'GET',
      headers: { [ACTION_HEADER]: 'pins' },
      body: '',
    });
    assert.deepEqual(read.body.pins, []);
    assert.equal(read.body.ok, true);
    assert.equal(existsSync(join(blocker, 'plugin-data')), false, '失败后不该留下任何目录');
  });

  it('resolve 能读“所有分组来源都不可用”时的降级形态', async () => {
    const { routes } = mountHostPlugin({ profile: 'web', profileDir: '/definitely/not/a/profile' });
    const handler = routes.get('/settings-plugin-hub/resolve').handler;
    const result = await callHandler(handler, {
      method: 'POST',
      headers: { [ACTION_HEADER]: 'resolve', 'content-type': 'application/json' },
      body: JSON.stringify({ sections: [{ id: 'vision', label: '视觉助手', order: 11 }] }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, false);
    assert.deepEqual(result.body.hiddenIds, []);
    assert.deepEqual(result.body.groups.unknown, []);
    assert.match(result.body.error, /profile package\.json not found/);
  });

  it('坏请求体 400，乱形状的 sections 被吞掉而不是炸掉', async () => {
    const bad = await fetch(url('/settings-plugin-hub/resolve'), {
      method: 'POST',
      headers: { [ACTION_HEADER]: 'resolve' },
      body: '{not json',
    });
    assert.equal(bad.status, 400);
    const weird = await fetch(url('/settings-plugin-hub/resolve'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'resolve' },
      body: JSON.stringify({ sections: 'not-an-array' }),
    });
    assert.equal(weird.status, 200);
    const body = await weird.json();
    assert.equal(body.ok, hasProfile);
  });

  it('卸载时路由随 effect dispose 一起撤下', async () => {
    const { routes, effects } = mountHostPlugin({ profile: 'web', profileDir: REAL_PROFILE_DIR, dataDir });
    assert.equal(routes.size, 3);
    for (const close of effects) close();
    assert.equal(routes.size, 0);
  });
});

/** 直接调用 handler（不经过 HTTP），用于拿不到 baseUrl 的场景。 */
function callHandler(handler, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = new ReadableFromString(body);
    request.method = method;
    request.headers = headers;
    const chunks = [];
    const response = {
      status: 0,
      headers: {},
      writeHead(status, extra) {
        this.status = status;
        this.headers = { ...(extra ?? {}) };
      },
      end(payload) {
        if (payload !== undefined) chunks.push(Buffer.from(payload));
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: this.status, headers: this.headers, body: JSON.parse(text) });
        } catch (error) {
          reject(new Error(`non-JSON response: ${text}`));
        }
      },
    };
    Promise.resolve(handler(request, response)).catch(reject);
  });
}

/** 最小的可读流：handler 会 for-await 读它。 */
function ReadableFromString(text) {
  const buffer = Buffer.from(text ?? '', 'utf8');
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
