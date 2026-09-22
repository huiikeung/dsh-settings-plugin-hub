/**
 * dsh-settings-plugin-hub —— 侧栏图标 Pin（pinNavGlyph）单元测试。
 *
 * 仍然加载真实产物 lib/client.js（tests/load-client.mjs 的 __ModuleLoader__ 桩），
 * 但 pinNavGlyph 只用 document 的一小块：一次 [role="dialog"] 存在性判断、一次
 * querySelectorAll('[role="dialog"] nav button')、以及每个导航格里的 <svg>。
 * MutationObserver 在 vm realm 里默认不存在（pinNavGlyph 按 typeof 早退），
 * 所以经 load-client.mjs 的 MutationObserver 选项注入打桩构造器。
 *
 * 覆盖：只改自己那一格、别人的格子原封不动、mark 幂等、便宜前置判断、
 * glyph() 抛错时保留外壳图标、以及 apply() 用真 label/mark/几何接线。
 */
import strict from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadClientBundle } from './load-client.mjs';

/** 本分页在设置左侧栏的显示名（lib/client.js 的 HUB_TITLE）。 */
const NAV_LABEL = '第三方插件';
/** 侧栏图标 Pin 的 DOM 标记（lib/client.js 调用处传的名字）。 */
const NAV_MARK = 'data-plugin-hub-nav-icon';

/** 最小 <svg> 桩：只记属性表与 innerHTML（pinNavGlyph 用到的全部）。 */
function createSvgStub() {
  return {
    attributes: {},
    innerHTML: '',
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
  };
}

/** 最小导航格桩：textContent 即标签（svg 不贡献文本），querySelector('svg') 返回格内图标。 */
function createCellStub(label, svg) {
  return { textContent: label, querySelector: (selector) => (selector === 'svg' ? svg : null) };
}

/**
 * 搭一套「设置弹窗已打开」的假 DOM：querySelector('[role="dialog"]') 返回对象，
 * querySelectorAll('[role="dialog"] nav button') 返回给定 cells；MutationObserver
 * 打桩，只记录 observe 的调用与回调。
 */
function createNavHarness(cells) {
  const observed = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target, options) {
      observed.push({ observer: this, target, options });
    }
    disconnect() {}
  }
  const document = {
    body: { tagName: 'BODY' },
    querySelector: (selector) => (selector === '[role="dialog"]' ? { role: 'dialog' } : null),
    querySelectorAll: (selector) => (selector === '[role="dialog"] nav button' ? cells : []),
  };
  return { document, FakeMutationObserver, observed };
}

/** 测试用 glyph：形状不重要，要的是「纯函数、返回规格」这个契约。 */
const testGlyph = () => ({
  viewBox: '0 0 24 24',
  stroke: 'currentColor',
  markup: '<rect x="4" y="4" width="16" height="16" rx="3"></rect>',
});

describe('侧栏图标 Pin pinNavGlyph', () => {
  it('只改写标签匹配的那一格：换几何、打 mark，别人的格子原封不动', () => {
    const ourSvg = createSvgStub();
    const otherSvg = createSvgStub();
    const cells = [createCellStub('模型', otherSvg), createCellStub(NAV_LABEL, ourSvg)];
    const harness = createNavHarness(cells);
    const { exports } = loadClientBundle({ document: harness.document, MutationObserver: harness.FakeMutationObserver });

    strict.equal(typeof exports.pinNavGlyph, 'function', 'pinNavGlyph 应导出供单测');
    exports.pinNavGlyph([NAV_LABEL], NAV_MARK, testGlyph);

    // 自己那一格：几何与 mark 都落上（stroke 三件套也跟着 spec.stroke 走）。
    strict.equal(ourSvg.getAttribute('viewBox'), '0 0 24 24');
    strict.equal(ourSvg.getAttribute('fill'), 'none');
    strict.equal(ourSvg.getAttribute('stroke'), 'currentColor');
    strict.equal(ourSvg.getAttribute('stroke-width'), '1.8');
    strict.equal(ourSvg.getAttribute('stroke-linecap'), 'round');
    strict.equal(ourSvg.getAttribute('stroke-linejoin'), 'round');
    strict.equal(ourSvg.innerHTML, '<rect x="4" y="4" width="16" height="16" rx="3"></rect>');
    strict.equal(ourSvg.getAttribute('aria-hidden'), 'true');
    strict.equal(ourSvg.getAttribute(NAV_MARK), '1');
    // 别人的格子：一个属性、一个字符都不许动。
    strict.deepEqual(otherSvg.attributes, {});
    strict.equal(otherSvg.innerHTML, '');

    // 观察器挂上：外壳重渲染导航（齿轮回来）时再 Pin 一遍。
    strict.equal(harness.observed.length, 1);
    strict.equal(harness.observed[0].target, harness.document.body);
    strict.equal(harness.observed[0].options.childList, true);
    strict.equal(harness.observed[0].options.subtree, true);
  });

  it('已打 mark 的格子跳过：观察器回调重放不会二次改写', () => {
    const ourSvg = createSvgStub();
    const cells = [createCellStub(NAV_LABEL, ourSvg)];
    const harness = createNavHarness(cells);
    const { exports } = loadClientBundle({ document: harness.document, MutationObserver: harness.FakeMutationObserver });

    exports.pinNavGlyph([NAV_LABEL], NAV_MARK, testGlyph);
    const afterFirst = { ...ourSvg.attributes, __html: ourSvg.innerHTML };
    // 模拟外壳重渲染后 MutationObserver 再触发一次；换一个会抛错的 glyph ——
    // 只要 mark 在，就根本不该跑到 glyph()。
    const callback = harness.observed[0].observer.callback;
    exports.pinNavGlyph([NAV_LABEL], NAV_MARK, () => {
      throw new Error('should not run');
    });
    callback();
    strict.deepEqual({ ...ourSvg.attributes, __html: ourSvg.innerHTML }, afterFirst);
  });

  it('设置弹窗没开（querySelector 返回 null）时不动格子，但观察器照挂', () => {
    const ourSvg = createSvgStub();
    const cells = [createCellStub(NAV_LABEL, ourSvg)];
    const observed = [];
    class FakeMutationObserver {
      observe(target, options) {
        observed.push({ target, options });
      }
    }
    const document = {
      body: {},
      querySelector: () => null,
      querySelectorAll: () => cells,
    };
    const { exports } = loadClientBundle({ document, MutationObserver: FakeMutationObserver });

    exports.pinNavGlyph([NAV_LABEL], NAV_MARK, testGlyph);
    strict.deepEqual(ourSvg.attributes, {});
    strict.equal(ourSvg.innerHTML, '');
    strict.equal(observed.length, 1, '便宜前置判断只跳过本轮，观察器仍要挂上');
  });

  it('glyph() 抛错时保留外壳图标：console.warn 后 continue，格子不被清空', () => {
    const ourSvg = createSvgStub();
    ourSvg.innerHTML = '<shell-gear></shell-gear>'; // 外壳原来的齿轮
    const otherSvg = createSvgStub();
    const cells = [createCellStub(NAV_LABEL, ourSvg), createCellStub('模型', otherSvg)];
    const harness = createNavHarness(cells);
    const { exports } = loadClientBundle({ document: harness.document, MutationObserver: harness.FakeMutationObserver });

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args);
    };
    try {
      exports.pinNavGlyph([NAV_LABEL], NAV_MARK, () => {
        throw new Error('boom');
      });
    } finally {
      console.warn = originalWarn;
    }
    strict.equal(warnings.length, 1, '抛错应 warn 一次');
    strict.match(String(warnings[0][0]), /nav glyph failed/);
    // 外壳图标原封不动，也没有打上 mark（下一轮还会重试）。
    strict.equal(ourSvg.innerHTML, '<shell-gear></shell-gear>');
    strict.equal(ourSvg.getAttribute(NAV_MARK), null);
    strict.deepEqual(ourSvg.attributes, {});
    strict.deepEqual(otherSvg.attributes, {});
  });

  it('realm 里没有 MutationObserver 时直接返回，不炸也不碰 DOM', () => {
    const ourSvg = createSvgStub();
    const cells = [createCellStub(NAV_LABEL, ourSvg)];
    const document = {
      body: {},
      querySelector: (selector) => (selector === '[role="dialog"]' ? {} : null),
      querySelectorAll: (selector) => (selector === '[role="dialog"] nav button' ? cells : []),
    };
    // 不传 MutationObserver：vm realm 里它是 undefined。
    const { exports } = loadClientBundle({ document });
    exports.pinNavGlyph([NAV_LABEL], NAV_MARK, testGlyph);
    strict.deepEqual(ourSvg.attributes, {});
    strict.equal(ourSvg.innerHTML, '');
  });

  it('apply() 在装样式之后用真 label/mark/几何接线（端到端）', () => {
    const ourSvg = createSvgStub();
    const otherSvg = createSvgStub();
    const cells = [createCellStub('模型', otherSvg), createCellStub(NAV_LABEL, ourSvg)];
    const harness = createNavHarness(cells);
    const order = [];
    const rawSetAttribute = ourSvg.setAttribute.bind(ourSvg);
    ourSvg.setAttribute = (name, value) => {
      if (name === NAV_MARK) order.push('mark');
      rawSetAttribute(name, value);
    };
    const styleTag = {
      dataset: {},
      textContent: '',
    };
    const document = {
      body: harness.document.body,
      head: {
        appendChild: (child) => {
          order.push('style');
          return child;
        },
      },
      createElement: () => {
        order.push('createElement');
        return styleTag;
      },
      // installStyles 先问一次样式标签在不在；pinNavGlyph 问 dialog 在不在。
      querySelector: (selector) => {
        if (selector === 'style[data-plugin="dsh-settings-plugin-hub"]') return null;
        return harness.document.querySelector(selector);
      },
      querySelectorAll: (selector) => harness.document.querySelectorAll(selector),
    };
    const injected = [];
    const effects = [];
    const ctx = {
      inject: (names, factory) => injected.push({ names, factory }),
      effect: (factory, label) => effects.push({ factory, label }),
    };
    const { exports } = loadClientBundle({ document, MutationObserver: harness.FakeMutationObserver });

    exports.apply(ctx);

    // 真几何（IconCordisPluginOutline14，规格见 /tmp/navglyph-specs 与 navGlyph 注释）：
    // viewBox 0 0 14 14、fill=none、无 stroke（形状全部 fill=currentColor）、clipPath 就位。
    strict.equal(ourSvg.getAttribute('viewBox'), '0 0 14 14');
    strict.equal(ourSvg.getAttribute('fill'), 'none');
    strict.equal(ourSvg.getAttribute('stroke'), null, '该图标没有 stroke，不设三件套');
    strict.equal(ourSvg.getAttribute('aria-hidden'), 'true');
    strict.equal(ourSvg.getAttribute(NAV_MARK), '1');
    strict.match(ourSvg.innerHTML, /url\(#clip0_1840_45990\)/);
    strict.match(ourSvg.innerHTML, /M3\.03426 5\.66661/);
    strict.match(ourSvg.innerHTML, /<rect x="5\.98535" y="5\.98535" width="2\.02942" height="2\.02942"/);
    // 别人的格子仍然原封不动；观察器挂了一次。
    strict.deepEqual(otherSvg.attributes, {});
    strict.equal(harness.observed.length, 1);
    // 样式装在图标之前（任务要求的调用次序：installStyles 之后才 pinNavGlyph）。
    strict.ok(order.indexOf('createElement') >= 0, 'installStyles 应创建 style 标签');
    strict.ok(order.indexOf('style') >= 0, 'installStyles 应把 style 标签插进 head');
    strict.ok(order.indexOf('style') < order.indexOf('mark'), '样式安装必须先于图标 Pin');
    // ctx 接线不受影响：slots 注入与 rail watcher effect 的原样登记
    // （数组是 vm realm 造的，比字符串原语，避免 deepEqual 的原型陷阱）。
    strict.deepEqual(injected.map((entry) => entry.names.join(',')), ['slots']);
    strict.deepEqual(effects.map((entry) => entry.label), ['settings-plugin-hub: rail watcher']);
  });
});
