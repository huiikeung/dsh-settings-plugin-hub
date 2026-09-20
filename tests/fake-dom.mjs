/**
 * 极简假 DOM —— 只实现 dsh-settings-plugin-hub 的浏览器半边真正用到的那几个 API。
 *
 * 为什么要它：这台机器上 headless Chromium 起不来（root 无沙箱），但「把哪些原生
 * 分页按钮藏起来、点击卡片时点亮哪个按钮」正是本插件的核心行为，必须有测试覆盖。
 * 支持的选择器只有四种形状，其余一律抛错，避免测试假装支持了没实现的语义：
 *   'nav' / 'button'、'[attr="value"]'、'tag[attr="value"]'、':scope > span'
 */
export class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    // 真实 DOM 里 dataset 写入会同步成 data-* 属性（client-modules 靠属性清理样式），
    // 这里用 Proxy 复刻这条反射，否则选择器 'style[data-plugin="…"]' 会查不到。
    const datasetTarget = {};
    this.dataset = new Proxy(datasetTarget, {
      set: (target, property, value) => {
        target[property] = value;
        this.setAttribute(`data-${String(property).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, value);
        return true;
      },
    });
    this.style = {};
    this.textContent = "";
    this.clickCount = 0;
    this.listeners = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  click() {
    this.clickCount += 1;
    for (const fn of this.listeners.get("click") ?? []) fn();
  }

  /** 深度优先遍历自身子树（不含自身）。 */
  descendants() {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    const hits = this.querySelectorAll(selector);
    return hits.length > 0 ? hits[0] : null;
  }

  querySelectorAll(selector) {
    if (selector === ":scope > span") {
      const span = this.children.find((child) => child.tagName === "SPAN");
      return span === undefined ? [] : [span];
    }
    return this.descendants().filter((node) => matches(node, selector));
  }
}

/** 建一个带 body/head 的假 document。 */
export function createFakeDocument() {
  const document = new FakeElement("#document");
  const head = document.appendChild(new FakeElement("head"));
  const body = document.appendChild(new FakeElement("body"));
  document.head = head;
  document.body = body;
  document.createElement = (tag) => new FakeElement(tag);
  return document;
}

function matches(node, selector) {
  const withAttributes = /^([a-zA-Z]*)((?:\[[a-zA-Z-]+(?:="[^"]*")?\])+)$/.exec(selector);
  if (withAttributes !== null) {
    const tag = withAttributes[1];
    if (tag !== "" && node.tagName !== tag.toUpperCase()) return false;
    const parts = withAttributes[2].match(/\[[a-zA-Z-]+(?:="[^"]*")?\]/g) ?? [];
    return parts.every((part) => {
      const parsed = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(part);
      return attributeMatches(node, parsed[1], parsed[2]);
    });
  }
  if (/^[a-zA-Z]+$/.test(selector)) return node.tagName === selector.toUpperCase();
  throw new Error(`fake-dom: unsupported selector ${selector}`);
}

function attributeMatches(node, name, value) {
  const actual = node.getAttribute(name);
  if (actual === null) return false;
  return value === undefined || actual === value;
}

/**
 * 搭一个「设置弹窗 + 左侧栏按钮」的骨架。
 * @param {Array<{label: string}>} rows - 左侧栏按钮的显示名（顺序即 DOM 顺序）。
 * @returns {{document: FakeElement, dialog: FakeElement, nav: FakeElement, buttons: FakeElement[]}}
 */
export function createSettingsDialog(rows) {
  const document = createFakeDocument();
  const dialog = document.body.appendChild(new FakeElement("div"));
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const nav = dialog.appendChild(new FakeElement("nav"));
  const title = nav.appendChild(new FakeElement("div"));
  title.textContent = "设置";
  const list = nav.appendChild(new FakeElement("div"));
  /** @type {FakeElement[]} */
  const buttons = rows.map((row) => {
    const button = list.appendChild(new FakeElement("button"));
    button.appendChild(new FakeElement("svg"));
    const span = button.appendChild(new FakeElement("span"));
    span.textContent = row.label;
    return button;
  });
  return { document, dialog, nav, buttons };
}
