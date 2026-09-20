/**
 * dsh-settings-plugin-hub —— 浏览器半边单元测试。
 *
 * 测的是 lib/client.js 这个**会被浏览器真正执行的产物**：用一个
 * window.__ModuleLoader__ 桩加载 bundle，再用最小假 DOM 驱动左侧栏收纳。
 * 覆盖：账本投影、索引/label 对齐、收纳与还原、点击代理、与宿主对话的成败两条路径。
 */
import strict from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFakeDocument, createSettingsDialog } from './fake-dom.mjs';
import { loadClientBundle, reactStub } from './load-client.mjs';

/**
 * bundle 跑在 vm 的独立 realm 里，它创建的数组/对象原型与宿主的不是同一个，
 * `assert.deepEqual` 会因原型不等而报错。这里统一先转成宿主侧普通值再比较 ——
 * 比较的是结构与取值，不是 realm 身份。
 */
const toPlain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const assert = {
  equal: (actual, expected, message) => strict.equal(actual, expected, message),
  notEqual: (actual, expected, message) => strict.notEqual(actual, expected, message),
  ok: (value, message) => strict.ok(value, message),
  match: (value, pattern, message) => strict.match(value, pattern, message),
  deepEqual: (actual, expected, message) => strict.deepEqual(toPlain(actual), toPlain(expected), message),
};

/** 假 window：定时器可控（避免测试进程被 2s 的兜底轮询拖住）。 */
function createFakeWindow(extra = {}) {
  const intervals = new Map();
  let nextId = 1;
  return {
    intervals,
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
    ...extra,
  };
}

/** 左侧栏账本条目（形状同 ctx.slots.entries('settings.section')）。 */
function entry(id, label, order, registrant) {
  return { options: { id, label: () => label, order, ...(registrant === undefined ? {} : { registrant }) } };
}

const LEDGER = [
  entry('general', '通用', 0, 'ui-settings-general'),
  entry('models', '模型', 10, 'ui-settings-models'),
  entry('vision', '视觉助手', 11, 'dsh-vision-assistant'),
  entry('plugins', '内置插件', 15, 'ui-settings-plugins'),
  entry('better-display', '界面增强', 40, 'dsh-better-display-client'),
  entry('third-party-plugins', '第三方插件', 1000, 'dsh-settings-plugin-hub-client'),
];

const DOM_ROWS = [
  { label: '通用' },
  { label: '模型' },
  { label: '视觉助手' },
  { label: '内置插件' },
  { label: '界面增强' },
  { label: '第三方插件' },
];

/** 宿主 /resolve 的应答。 */
function resolveBody(overrides = {}) {
  return {
    ok: true,
    profile: 'web',
    builtin: ['general', 'models', 'plugins'],
    hiddenIds: ['vision', 'better-display'],
    groups: {
      local: [
        { id: 'vision', label: '视觉助手', order: 11, package: 'dsh-vision-assistant', spec: 'link:dsh-vision-assistant' },
        { id: 'better-display', label: '界面增强', order: 40, package: 'dsh-better-display', spec: 'link:dsh-better-display' },
      ],
      remote: [
        { id: 'cost-meter', label: '用量计费', order: 30, package: 'dsh-cost-meter', spec: '^1.7.30' },
      ],
      unknown: [],
    },
    ...overrides,
  };
}

function fetchReturning(body, status = 200) {
  return () => Promise.resolve({ status, json: () => Promise.resolve(body) });
}

/** 等链式 then 走完。 */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('bundle 契约', () => {
  it('按 DSH client 模块系统约定声明 id / name / apply', () => {
    const loaded = loadClientBundle();
    assert.equal(loaded.id, 'dsh-settings-plugin-hub');
    assert.equal(loaded.exports.name, 'dsh-settings-plugin-hub-client');
    assert.equal(typeof loaded.exports.apply, 'function');
    assert.equal(loaded.exports.__internals.SECTION_ID, 'third-party-plugins');
  });
});

describe('账本投影 rowsFromEntries', () => {
  it('按 order 排序、解析 label thunk、保留缺 id 的行以对齐外壳', () => {
    const { exports } = loadClientBundle();
    const rows = exports.__internals.rowsFromEntries([
      entry('b', '乙', 20),
      entry('a', '甲', 10),
      { options: { order: 5 } },
    ]);
    assert.deepEqual(rows.map((row) => row.id), ['', 'a', 'b']);
    assert.deepEqual(rows.map((row) => row.label), ['', '甲', '乙']);
  });

  it('label 抛错时退化为空串而不是炸掉外壳', () => {
    const { exports } = loadClientBundle();
    const rows = exports.__internals.rowsFromEntries([{ options: { id: 'x', label: () => { throw new Error('boom'); } } }]);
    assert.equal(rows[0].label, '');
  });
});

describe('左侧栏对齐与收纳计划 planRail', () => {
  const { __internals } = loadClientBundle().exports;
  const rows = [
    { id: 'general', label: '通用' },
    { id: 'vision', label: '视觉助手' },
    { id: 'better-display', label: '界面增强' },
  ];

  it('索引对齐时逐行对应，命中收纳集合的标记 hide', () => {
    const buttons = [{ label: '通用' }, { label: '视觉助手' }, { label: '界面增强' }];
    assert.deepEqual(__internals.planRail(rows, buttons, ['vision'], false), [
      { index: 0, id: 'general', hide: false },
      { index: 1, id: 'vision', hide: true },
      { index: 2, id: 'better-display', hide: false },
    ]);
  });

  it('索引位 label 不符时退化为按 label 找唯一匹配', () => {
    const buttons = [{ label: '界面增强' }, { label: '通用' }, { label: '视觉助手' }];
    assert.deepEqual(__internals.planRail(rows, buttons, ['better-display'], false), [
      { index: 1, id: 'general', hide: false },
      { index: 2, id: 'vision', hide: false },
      { index: 0, id: 'better-display', hide: true },
    ]);
  });

  it('label 对不上且找不到同名按钮时不动 DOM（宁可少藏也不错藏）', () => {
    const plan = __internals.planRail(rows, [{ label: '完全不一样的按钮' }], ['vision'], false);
    assert.deepEqual(plan, []);
  });

  it('showAll 时不藏任何一个', () => {
    const buttons = [{ label: '通用' }, { label: '视觉助手' }, { label: '界面增强' }];
    assert.ok(__internals.planRail(rows, buttons, ['vision', 'better-display'], true).every((step) => !step.hide));
  });
});

describe('分组归一化', () => {
  const { __internals } = loadClientBundle().exports;

  it('丢掉脏数据、补默认字段', () => {
    const groups = __internals.normalizeGroups({
      local: [{ id: 'a', label: 'A' }, null, { id: '' }, 'junk'],
      remote: [{ id: 'b' }],
      unknown: undefined,
    });
    assert.deepEqual(groups.local.map((item) => [item.id, item.label]), [['a', 'A']]);
    assert.deepEqual(groups.remote.map((item) => [item.id, item.label]), [['b', 'b']]);
    assert.deepEqual(groups.unknown, []);
  });

  it('allGroupIds 汇总三个分组并去重', () => {
    const ids = __internals.allGroupIds({
      local: [{ id: 'a' }],
      remote: [{ id: 'b' }, { id: 'a' }],
      unknown: [{ id: 'c' }],
    });
    assert.deepEqual(ids.sort(), ['a', 'b', 'c']);
  });

  it('safeId 只放行安全字符', () => {
    assert.equal(__internals.safeId('better-display'), 'better-display');
    assert.equal(__internals.safeId('a/b'), null);
    assert.equal(__internals.safeId('"x"'), null);
    assert.equal(__internals.safeId(undefined), null);
  });
});

describe('DOM：收纳左侧栏', () => {
  it('applyRail 给按钮打标记并隐藏被收纳的分页，且可反复重放（React 重建后仍生效）', () => {
    const { document, buttons } = createSettingsDialog(DOM_ROWS);
    const { exports } = loadClientBundle({ document });
    const api = exports.__internals;
    api.setState({
      status: 'ready',
      sections: api.rowsFromEntries(LEDGER),
      hiddenIds: ['vision', 'better-display'],
    });
    assert.equal(api.applyRail(), 6);
    assert.equal(buttons[2].style.display, 'none');
    assert.equal(buttons[4].style.display, 'none');
    assert.equal(buttons[2].getAttribute(api.ATTR_SECTION), 'vision');
    assert.equal(buttons[0].style.display, undefined);
    // 第二次重放：标记应被清理后重建，不出现半隐藏状态。
    api.applyRail();
    assert.equal(buttons[2].getAttribute(api.ATTR_HIDDEN), '1');
    assert.equal(buttons[0].getAttribute(api.ATTR_HIDDEN), null);
  });

  it('showAll 打开后把已经藏起来的按钮还原', () => {
    const { document, buttons } = createSettingsDialog(DOM_ROWS);
    const { exports } = loadClientBundle({ document });
    const api = exports.__internals;
    api.setState({ sections: api.rowsFromEntries(LEDGER), hiddenIds: ['vision'] });
    api.applyRail();
    assert.equal(buttons[2].style.display, 'none');
    api.setState({ showAll: true });
    api.applyRail();
    assert.equal(buttons[2].style.display, '');
    assert.equal(buttons[2].getAttribute(api.ATTR_HIDDEN), null);
  });

  it('弹窗未打开时不动 DOM', () => {
    const document = createFakeDocument();
    const { exports } = loadClientBundle({ document });
    const api = exports.__internals;
    api.setState({ sections: api.rowsFromEntries(LEDGER), hiddenIds: ['vision'] });
    assert.equal(api.applyRail(), 0);
  });

  it('别的对话框（左侧栏里没有本插件那一行）一律不碰', () => {
    const { document, buttons } = createSettingsDialog([{ label: '通用' }, { label: '视觉助手' }]);
    const { exports } = loadClientBundle({ document });
    const api = exports.__internals;
    api.setState({ sections: api.rowsFromEntries(LEDGER), hiddenIds: ['vision'] });
    assert.equal(api.applyRail(), 0);
    assert.equal(buttons[1].style.display, undefined);
    assert.equal(buttons[1].getAttribute(api.ATTR_SECTION), null);
  });

  it('openSection 点亮被隐藏的原生按钮——官方外壳照常完成分页切换', () => {
    const { document, buttons } = createSettingsDialog(DOM_ROWS);
    const { exports } = loadClientBundle({ document });
    const api = exports.__internals;
    api.setState({ sections: api.rowsFromEntries(LEDGER), hiddenIds: ['vision', 'better-display'] });
    api.applyRail();
    assert.equal(api.openSection('vision'), true);
    assert.equal(buttons[2].clickCount, 1);
    assert.equal(api.openSection('nope'), false);
    assert.equal(api.openSection('a/b'), false);
  });

  it('buttonLabel 读 span 文本，querySelector 不可用时退回子节点扫描', () => {
    const { document, buttons } = createSettingsDialog(DOM_ROWS);
    const { exports } = loadClientBundle({ document });
    const api = exports.__internals;
    assert.equal(api.buttonLabel(buttons[1]), '模型');
    const broken = {
      children: [{ tagName: 'SPAN', textContent: '甲' }],
      textContent: '甲',
      querySelector: () => {
        throw new Error(':scope unsupported');
      },
    };
    assert.equal(api.buttonLabel(broken), '甲');
  });
});

describe('与宿主对话 resolveNow', () => {
  it('成功：POST /settings-plugin-hub/resolve（带动作头）→ 分组入库并立即收纳', async () => {
    const { document, buttons } = createSettingsDialog(DOM_ROWS);
    const window = createFakeWindow();
    const { exports, fetchCalls } = loadClientBundle({
      document,
      window,
      fetchImpl: fetchReturning(resolveBody()),
    });
    const api = exports.__internals;
    api.resolveNow({ slots: { entries: () => LEDGER } });
    await settle();

    const snapshot = api.getState();
    assert.equal(snapshot.status, 'ready');
    assert.deepEqual(snapshot.hiddenIds, ['vision', 'better-display']);
    assert.equal(snapshot.groups.local.length, 2);
    assert.equal(buttons[2].style.display, 'none');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, '/settings-plugin-hub/resolve');
    assert.equal(fetchCalls[0].init.method, 'POST');
    assert.equal(fetchCalls[0].init.headers['x-settings-plugin-hub-action'], 'resolve');
    const payload = JSON.parse(fetchCalls[0].init.body);
    assert.deepEqual(payload.sections.map((row) => row.id), LEDGER.map((item) => item.options.id));
  });

  it('失败：一个分页都不藏，并把已在藏的还原（左侧栏回到原生）', async () => {
    const { document, buttons } = createSettingsDialog(DOM_ROWS);
    const window = createFakeWindow();
    const { exports } = loadClientBundle({ document, window, fetchImpl: () => Promise.reject(new Error('endpoint down')) });
    const api = exports.__internals;
    api.setState({ sections: api.rowsFromEntries(LEDGER), hiddenIds: ['vision', 'better-display'] });
    api.applyRail();
    assert.equal(buttons[2].style.display, 'none');

    api.resolveNow({ slots: { entries: () => LEDGER } });
    await settle();
    const snapshot = api.getState();
    assert.equal(snapshot.status, 'error');
    assert.match(snapshot.error, /endpoint down/);
    assert.deepEqual(snapshot.hiddenIds, []);
    assert.equal(buttons[2].style.display, '');
    assert.equal(buttons[4].style.display, '');
  });

  it('宿主返回 ok:false 时同样不藏', async () => {
    const { document, buttons } = createSettingsDialog(DOM_ROWS);
    const window = createFakeWindow();
    const { exports } = loadClientBundle({
      document,
      window,
      fetchImpl: fetchReturning({ ok: false, error: 'profile package.json not found' }),
    });
    const api = exports.__internals;
    api.resolveNow({ slots: { entries: () => LEDGER } });
    await settle();
    assert.equal(api.getState().status, 'error');
    assert.match(api.getState().error, /profile package\.json not found/);
    assert.equal(buttons[2].style.display, undefined);
  });

  it('账本为空时不发请求', async () => {
    const { document } = createSettingsDialog(DOM_ROWS);
    const window = createFakeWindow();
    const { exports, fetchCalls } = loadClientBundle({ document, window, fetchImpl: fetchReturning(resolveBody()) });
    exports.__internals.resolveNow({ slots: { entries: () => [] } });
    await settle();
    assert.equal(fetchCalls.length, 0);
    assert.equal(exports.__internals.getState().status, 'loading');
  });
});

describe('apply 接线', () => {
  it('注册收纳分页、订阅账本、启动左侧栏观察器，且 dispose 后还原 DOM', async () => {
    const { document, buttons } = createSettingsDialog(DOM_ROWS);
    const window = createFakeWindow();
    const { exports, fetchCalls } = loadClientBundle({
      document,
      window,
      fetchImpl: fetchReturning(resolveBody()),
    });

    const registered = [];
    const disposers = [];
    const scope = {
      slots: {
        entries: () => LEDGER,
        subscribe: () => () => {},
        inject: (name, factory) => {
          assert.equal(name, 'settings.section');
          factory();
        },
        register: (options, component) => {
          registered.push({ options, component });
          return () => {};
        },
      },
      effect: (fn) => disposers.push(fn()),
    };
    const ctx = {
      inject: (deps, cb) => {
        assert.equal(Array.from(deps).join(','), 'slots');
        cb(scope);
      },
      effect: (fn) => disposers.push(fn()),
    };

    exports.apply(ctx);
    await settle();

    assert.equal(registered.length, 1);
    assert.equal(registered[0].options.id, 'third-party-plugins');
    assert.equal(registered[0].options.order, 1000);
    assert.equal(registered[0].options.label(), '第三方插件');
    assert.equal(typeof registered[0].component, 'function');
    assert.equal(fetchCalls.length, 1);
    assert.equal(buttons[2].style.display, 'none');
    assert.equal(document.querySelectorAll('style[data-plugin="dsh-settings-plugin-hub"]').length, 1);

    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose();
    }
    assert.equal(buttons[2].style.display, '', '插件卸载后左侧栏必须还原');
    assert.equal(buttons[2].getAttribute('data-dsh-hub-section'), null);
  });

  it('收纳页组件能渲染出标题与分组（smoke）', () => {
    const { document } = createSettingsDialog(DOM_ROWS);
    const { exports } = loadClientBundle({ document, react: reactStub });
    const api = exports.__internals;
    api.setState({ status: 'ready', ...resolveGroupsFrom(resolveBody()) });
    const text = collectText(api.HubSection()).join(' | ');
    assert.match(text, /第三方插件/);
    assert.match(text, /本地安装 · 2/);
    assert.match(text, /非本地安装 · 1/);
    assert.match(text, /dsh-vision-assistant/);
    // 「来源未识别」为空组时应整组不渲染。
    assert.ok(!text.includes('来源未识别'));
    // 固定数为 0：整块「固定」区域默认不渲染（标题与空状态提示都不出现）。
    assert.ok(!text.includes('固定在左侧栏显示'));
    assert.ok(!text.includes('还没有固定任何分页'));
    // 但发现路径必须留着：卡片右侧有「固定」按钮，说明里也点了它。
    assert.match(text, /固定/);
    assert.match(text, /点它右侧的「固定」/);
  });
});

describe('固定为 0 时「固定」区域默认隐藏', () => {
  const readyState = (api, extra) => ({
    status: 'ready',
    sections: api.rowsFromEntries(LEDGER),
    hiddenIds: ['vision', 'better-display', 'cost-meter'],
    groups: api.normalizeGroups(resolveBody().groups),
    ...extra,
  });

  it('pins=0 时：标题、空状态提示、已保存状态行都不渲染，分组列表照常', () => {
    const { document } = createSettingsDialog(DOM_ROWS);
    const { exports } = loadClientBundle({ document, react: reactStub });
    const api = exports.__internals;
    // pinsUpdatedAt > 0 也不能把「已保存」那一行带回来 —— 它也属于被隐藏的那一块。
    api.setState(readyState(api, { pins: [], pinsUpdatedAt: 1760000000000 }));
    const text = collectText(api.HubSection()).join(' | ');
    assert.ok(!text.includes('固定在左侧栏显示'), '标题不该出现');
    assert.ok(!text.includes('还没有固定任何分页'), '空状态提示不该出现');
    assert.ok(!text.includes('固定设置已保存'), '已保存状态行不该出现');
    assert.match(text, /本地安装 · 2/, '分组列表必须照常显示，否则没法固定第一个');
    assert.match(text, /非本地安装 · 1/);
  });

  it('pins≥1 时：整块回来，含标题、卡片「×」与说明', () => {
    const { document } = createSettingsDialog(DOM_ROWS);
    const { exports } = loadClientBundle({ document, react: reactStub });
    const api = exports.__internals;
    api.setState(readyState(api, { pins: ['vision'], pinsUpdatedAt: 1760000000000 }));
    const text = collectText(api.HubSection()).join(' | ');
    assert.match(text, /固定设置已保存/);
    assert.match(text, /固定在左侧栏显示 · 1/);
    assert.match(text, /视觉助手/);
    assert.match(text, /×/);
    assert.match(text, /这些分页不受收纳影响/);
    assert.ok(!text.includes('还没有固定任何分页'));
    // 写盘回执的位置：必须在「这些分页不受收纳影响…」那句之下（也就是这一块的最后一行），
    // 而不是像以前那样飘在页面顶端。
    assert.ok(
      text.indexOf('这些分页不受收纳影响') < text.indexOf('固定设置已保存'),
      '「固定设置已保存」应渲染在说明之下',
    );
    assert.ok(
      text.indexOf('固定在左侧栏显示 · 1') < text.indexOf('固定设置已保存'),
      '「固定设置已保存」属于这一块，不该出现在它前面',
    );
  });

  it('固定项指向的分页已不在分组里（插件卸载）⇒ 等于 0，整块仍然隐藏', () => {
    const { document } = createSettingsDialog(DOM_ROWS);
    const { exports } = loadClientBundle({ document, react: reactStub });
    const api = exports.__internals;
    api.setState(readyState(api, { pins: ['ghost-section'], pinsUpdatedAt: 1760000000000 }));
    const text = collectText(api.HubSection()).join(' | ');
    assert.ok(!text.includes('固定在左侧栏显示'));
    assert.ok(!text.includes('固定设置已保存'));
  });

  it('写盘失败 / 写入中这类「刚才那次操作」的提示不受隐藏影响', () => {
    const { document } = createSettingsDialog(DOM_ROWS);
    const { exports } = loadClientBundle({ document, react: reactStub });
    const api = exports.__internals;
    api.setState(readyState(api, { pins: [], pinsError: '固定设置没能保存：pins endpoint down' }));
    const withError = collectText(api.HubSection()).join(' | ');
    assert.match(withError, /固定设置没能保存/, '错误必须留在屏幕上，不能跟着一起藏');
    assert.ok(!withError.includes('固定在左侧栏显示'));

    // 写入中（乐观阶段已经把 pins 加上去了）⇒ 块立即出现，且此时不显示「已保存」
    api.setState(readyState(api, { pins: ['vision'], pinsUpdatedAt: 1760000000000, pinsBusy: true, pinsError: '' }));
    const busy = collectText(api.HubSection()).join(' | ');
    assert.match(busy, /固定在左侧栏显示 · 1/);
    assert.ok(!busy.includes('固定设置已保存'), '还没写成功就不该说已保存');
  });

  it('PinnedPicker 自己在 items 为空时返回 null（第二道闸）；notice 渲染在说明之下', () => {
    const { document } = createSettingsDialog(DOM_ROWS);
    const { exports } = loadClientBundle({ document, react: reactStub });
    const api = exports.__internals;
    assert.equal(api.PinnedPicker({ items: [] }), null);
    assert.equal(api.PinnedPicker({}), null);

    const withoutNotice = collectText(api.PinnedPicker({ items: [{ id: 'vision', label: '视觉助手' }] })).join(' | ');
    assert.match(withoutNotice, /固定在左侧栏显示 · 1/);
    assert.match(withoutNotice, /视觉助手/);
    assert.ok(!withoutNotice.includes('固定设置已保存'), '没传 notice 就不该有那一行');

    const withNotice = collectText(api.PinnedPicker({
      items: [{ id: 'vision', label: '视觉助手' }],
      notice: '固定设置已保存：2026/9/20 17:11:39',
    })).join(' | ');
    assert.match(withNotice, /固定设置已保存：2026\/9\/20 17:11:39/);
    assert.ok(withNotice.indexOf('这些分页不受收纳影响') < withNotice.indexOf('固定设置已保存'));
  });
});

describe('固定在左侧栏显示', () => {
  const groupsFrom = (body) => {
    const api = loadClientBundle().exports.__internals;
    return { groups: api.normalizeGroups(body.groups), hiddenIds: body.hiddenIds };
  };

  it('effectiveHiddenIds = 收纳全集 − 固定项', () => {
    const { __internals } = loadClientBundle().exports;
    assert.deepEqual(__internals.effectiveHiddenIds(['a', 'b', 'c'], []), ['a', 'b', 'c']);
    assert.deepEqual(__internals.effectiveHiddenIds(['a', 'b', 'c'], ['b']), ['a', 'c']);
    assert.deepEqual(__internals.effectiveHiddenIds(['a', 'b'], ['b', 'a']), []);
    // 固定项里有已经不存在/不参与收纳的 id：不影响结果。
    assert.deepEqual(__internals.effectiveHiddenIds(['a'], ['ghost']), ['a']);
    // 脏输入不该炸
    assert.deepEqual(__internals.effectiveHiddenIds([' a ', 'a', 42], [null, 'a']), [42].filter((x) => typeof x === 'string'));
  });

  it('pinnedItems 只列当前分组里真实存在的固定项，顺序跟随 pins', () => {
    const { __internals } = loadClientBundle().exports;
    const groups = { local: [{ id: 'a', label: 'A' }], remote: [{ id: 'b', label: 'B' }], unknown: [] };
    assert.deepEqual(__internals.pinnedItems(groups, ['b', 'ghost', 'a']).map((item) => item.id), ['b', 'a']);
    assert.deepEqual(__internals.pinnedItems(groups, []), []);
    assert.equal(__internals.isPinned(['a'], 'a'), true);
    assert.equal(__internals.isPinned(['a'], 'b'), false);
  });

  it('固定一个被收纳的分页 → 它立刻回到左侧栏；取消 → 立刻收走', () => {
    const { document, buttons } = createSettingsDialog(DOM_ROWS);
    const window = createFakeWindow();
    const { exports } = loadClientBundle({ document, window, fetchImpl: pinEchoFetch() });
    const api = exports.__internals;
    api.setState({ status: 'ready', ...groupsFrom(resolveBody()), sections: api.rowsFromEntries(LEDGER), pins: [] });
    api.applyRail();
    assert.equal(buttons[2].style.display, 'none', '默认收纳');

    api.togglePinned('vision');
    assert.deepEqual(api.getState().pins, ['vision'], '乐观更新：不等往返');
    assert.equal(buttons[2].style.display, '', '固定后立刻在左侧栏显示');
    assert.equal(buttons[4].style.display, 'none', '没固定的照旧收着');
    assert.equal(api.getState().pinsBusy, true);

    return settle().then(() => {
      assert.deepEqual(api.getState().pins, ['vision'], '宿主回执与本地一致');
      assert.equal(api.getState().pinsBusy, false);
      assert.equal(api.getState().pinsUpdatedAt, 1700000000000);
      api.togglePinned('vision');
      assert.deepEqual(api.getState().pins, []);
      assert.equal(buttons[2].style.display, 'none', '取消固定后立刻收走');
      return settle();
    });
  });

  it('PUT 打的是 /pins、带动作头、body 是 {pins}', async () => {
    const { document } = createSettingsDialog(DOM_ROWS);
    const window = createFakeWindow();
    const { exports, fetchCalls } = loadClientBundle({ document, window, fetchImpl: pinEchoFetch() });
    const api = exports.__internals;
    api.setState({ status: 'ready', ...groupsFrom(resolveBody()), pins: [] });
    api.togglePinned('better-display');
    await settle();
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, '/settings-plugin-hub/pins');
    assert.equal(fetchCalls[0].init.method, 'PUT');
    assert.equal(fetchCalls[0].init.headers['x-settings-plugin-hub-action'], 'pins');
    assert.equal(fetchCalls[0].init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { pins: ['better-display'] });
  });

  it('落盘失败 → 回退到上一次成功的固定集合并说明原因（不留「假固定」）', async () => {
    const { document, buttons } = createSettingsDialog(DOM_ROWS);
    const window = createFakeWindow();
    const { exports } = loadClientBundle({ document, window, fetchImpl: pinEchoFetch({ fail: true }) });
    const api = exports.__internals;
    api.setState({ status: 'ready', ...groupsFrom(resolveBody()), sections: api.rowsFromEntries(LEDGER), pins: [] });
    api.applyRail();
    api.togglePinned('vision');
    assert.equal(buttons[2].style.display, '', '乐观阶段是显示着的');
    await settle();
    assert.deepEqual(api.getState().pins, [], '失败后回退');
    assert.equal(api.getState().pinsBusy, false);
    assert.match(api.getState().pinsError, /固定设置没能保存/);
    assert.match(api.getState().pinsError, /pins endpoint down/);
    assert.equal(buttons[2].style.display, 'none', '左侧栏跟着回退');
  });

  it('写入进行中 / 未就绪时不再接受点击（避免两次相邻点击互相覆盖）', async () => {
    const { document } = createSettingsDialog(DOM_ROWS);
    const window = createFakeWindow();
    const { exports, fetchCalls } = loadClientBundle({ document, window, fetchImpl: pinEchoFetch() });
    const api = exports.__internals;
    api.setState({ status: 'ready', ...groupsFrom(resolveBody()), pins: [] });
    api.togglePinned('vision');
    api.togglePinned('better-display');
    assert.deepEqual(api.getState().pins, ['vision'], '忙碌期的第二次点击被忽略');
    await settle();
    assert.equal(fetchCalls.length, 1);

    api.setState({ pinsBusy: false, status: 'error' });
    api.togglePinned('vision');
    assert.deepEqual(api.getState().pins, ['vision'], '读不到来源时不允许改固定项');
    assert.equal(fetchCalls.length, 1);
  });

  it('resolve 应答里的 pins 会被采用，并直接反映到左侧栏', async () => {
    const { document, buttons } = createSettingsDialog(DOM_ROWS);
    const window = createFakeWindow();
    const { exports } = loadClientBundle({
      document,
      window,
      fetchImpl: fetchReturning(resolveBody({ pins: ['vision'], pinsUpdatedAt: 1700000000000, pinsError: null })),
    });
    const api = exports.__internals;
    api.resolveNow({ slots: { entries: () => LEDGER } });
    await settle();
    assert.deepEqual(api.getState().pins, ['vision']);
    assert.equal(api.getState().pinsUpdatedAt, 1700000000000);
    assert.notEqual(buttons[2].style.display, 'none', '视觉助手已固定 → 留在左侧栏');
    assert.equal(buttons[2].getAttribute('data-dsh-hub-hidden'), null);
    assert.equal(buttons[4].style.display, 'none', '界面增强未固定 → 收纳');
  });

  it('手工选择区列出已固定项、卡片按钮显示「已固定」', () => {
    const { document } = createSettingsDialog(DOM_ROWS);
    const { exports } = loadClientBundle({ document, react: reactStub });
    const api = exports.__internals;
    api.setState({ status: 'ready', ...groupsFrom(resolveBody()), pins: ['vision', 'ghost'] });
    const text = collectText(api.HubSection()).join(' | ');
    assert.match(text, /固定在左侧栏显示 · 1/, 'ghost 不在分组里，不计入');
    assert.match(text, /视觉助手/);
    assert.match(text, /已固定/);
    assert.match(text, /固定/);
    assert.match(text, /左侧栏已收纳 1 个第三方分页，1 个已固定单独显示/);
  });
});

/**
 * 模拟宿主 /pins：把请求里的 pins 原样回显（真实宿主的语义就是这样），
 * 可选地模拟落盘失败。
 */
function pinEchoFetch({ fail = false } = {}) {
  return (url, init) => {
    if (fail) return Promise.reject(new Error('pins endpoint down'));
    const body = JSON.parse(init.body ?? '{}');
    return Promise.resolve({
      status: 200,
      json: () => Promise.resolve({ ok: true, profile: 'web', pins: body.pins ?? [], updatedAt: 1700000000000, dropped: 0 }),
    });
  };
}

/**
 * 把 createElement 打出的树摊成文本：函数组件按 props 就地求值再递归。
 * （reactStub 的 createElement 不会自己调用组件，这里补上这一层。）
 */
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

/** 把 /resolve 应答摊平成 setState 用的小工具（只给 smoke 测试用）。 */
function resolveGroupsFrom(body) {
  return {
    groups: {
      local: body.groups.local,
      remote: body.groups.remote,
      unknown: body.groups.unknown,
    },
    hiddenIds: body.hiddenIds,
  };
}
