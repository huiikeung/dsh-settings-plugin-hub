/**
 * 在 Node 里按 DSH client 模块系统的真实约定加载 lib/client.js：
 * 提供一个 `window.__ModuleLoader__.load({id, factory})` 桩，把 factory 的返回值
 * 当作浏览器半边的导出使用。这样测试覆盖的是**真正会被浏览器执行的产物**，
 * 而不是另写一份等价实现。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const BUNDLE_PATH = new URL('../lib/client.js', import.meta.url);

/** 平台共享模块的 react 桩：只够跑纯逻辑与一次组件树 smoke。 */
export const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => undefined,
};

/**
 * 加载 bundle。
 * @param {{react?: object, document?: object, window?: object, fetchImpl?: Function, MutationObserver?: Function}} [options]
 * @returns {{id: string, exports: object, window: object, fetchCalls: object[]}}
 */
export function loadClientBundle(options = {}) {
  const source = readFileSync(BUNDLE_PATH, 'utf8');
  const fetchCalls = [];
  const userFetch = options.fetchImpl;
  // 无论测试是否提供 fetch 桩，都记一笔，便于断言「发没发请求、发了什么」。
  const fetchImpl = (url, init) => {
    fetchCalls.push({ url, init });
    if (userFetch !== undefined) return userFetch(url, init);
    return Promise.reject(new Error('fetch not stubbed'));
  };
  const window = options.window ?? {};
  let captured = null;
  window.__ModuleLoader__ = {
    load(config) {
      captured = config;
    },
  };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchImpl,
    window,
  };
  if (options.document !== undefined) sandbox.document = options.document;
  // 侧栏图标 Pin（pinNavGlyph）按 typeof MutationObserver 早退；浏览器里它是全局，
  // vm realm 里默认没有。需要覆盖那条路径时由测试注入一个打桩的构造器。
  if (options.MutationObserver !== undefined) sandbox.MutationObserver = options.MutationObserver;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  if (captured === null) throw new Error('bundle never called window.__ModuleLoader__.load');
  const exportsObject = captured.factory((id) => {
    if (id === 'react') return options.react ?? reactStub;
    throw new Error(`unexpected platform require: ${id}`);
  });
  return { id: captured.id, exports: exportsObject, window, fetchCalls };
}
