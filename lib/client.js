/**
 * dsh-settings-plugin-hub —— 浏览器半边。
 *
 * 目标：让设置弹窗的左侧导航栏清爽。做法不是去改别人的注册（slot 账本由各插件
 * 自己的 fiber 拥有，第三方既不能撤销也不能改别人的条目），而是：
 *
 *   1. 自己注册一个 `settings.section` 分页「第三方插件」（order 1000，排在最后）；
 *   2. 把所有第三方插件注册的分页从左侧栏「收纳」掉——给对应 <button> 打上标记并
 *      `display:none`，元素本身留在 DOM 里，React 重渲染后由 MutationObserver 重放；
 *   3. 收纳页里按「本地安装 / 非本地安装 / 来源未识别」把分页列成卡片；
 *   4. 点击卡片时对那个被隐藏的原生 <button> 派发 click —— 官方外壳自己完成
 *      activeId 切换与内容渲染，因此第三方分页的原生行为（生命周期、关闭、路由）
 *      一字不改，我们只是把它藏起来又替用户点了一下。
 *
 * Bundle 格式遵循 DSH client 模块系统：window.__ModuleLoader__.load({id, factory})，
 * factory 通过 require() 取得平台共享模块（这里只用到 react）。
 *
 * 失败取向：宿主端点读不到时 status=error，hiddenIds 为空 —— 一个分页都不藏，
 * 左侧栏保持原生。收纳永远不该让人找不到东西。
 */
window.__ModuleLoader__.load({
	id: "dsh-settings-plugin-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var h = react.createElement;

		/** 收纳页自己的分页 id（与宿主 inventory.js 的 HUB_SECTION_ID 一致）。 */
		var SECTION_ID = "third-party-plugins";
		/** 左侧栏唯一保留的第三方入口标题。 */
		var HUB_TITLE = "第三方插件";
		/** 宿主端点前缀与动作头。 */
		var API_BASE = "/settings-plugin-hub";
		var ACTION_HEADER = "x-settings-plugin-hub-action";
		/** DOM 标记：原生分页按钮 → 分页 id / 是否已被收纳。 */
		var ATTR_SECTION = "data-dsh-hub-section";
		var ATTR_HIDDEN = "data-dsh-hub-hidden";
		/** 设置弹窗根节点（官方外壳的固定形状）。 */
		var DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';
		/** 账本变化后重新解析的防抖时长。 */
		var RESOLVE_DEBOUNCE_MS = 150;
		/** 弹窗存在时的兜底重放间隔（React 重渲染之外的意外丢失）。 */
		var RAIL_SWEEP_MS = 2000;
		/** 卡片标题：三个分组。 */
		var GROUP_TITLES = {
			local: "本地安装",
			remote: "非本地安装",
			unknown: "来源未识别",
		};

		//#region 外部 store（左侧栏 watch 与收纳页共享同一份快照）
		var state = {
			status: "loading", // loading | ready | error
			error: "",
			groups: { local: [], remote: [], unknown: [] },
			hiddenIds: [],
			sections: [],
			resolvedAt: 0,
			showAll: false,
			resolveError: "",
			// 「固定在左侧栏显示」白名单（宿主持久化在 plugin-data/…/pins.json）：
			// hiddenIds 减去 pins 才是真正收走的分页。
			pins: [],
			pinsUpdatedAt: 0,
			pinsBusy: false,
			pinsNotice: "",
			pinsError: "",
		};
		var listeners = new Set();

		function getState() {
			return state;
		}

		function setState(patch) {
			var next = {};
			for (var key in state) next[key] = state[key];
			for (var patchKey in patch) next[patchKey] = patch[patchKey];
			state = next;
			listeners.forEach(function (fn) {
				try {
					fn();
				} catch (error) {
					console.error("[settings-plugin-hub] listener failed:", error);
				}
			});
		}

		function subscribe(fn) {
			listeners.add(fn);
			return function () {
				listeners.delete(fn);
			};
		}
		//#endregion

		//#region 纯逻辑（可单测：不碰 DOM，只吃普通对象）
		/** 解析 slot 的 label（字符串或跟随语言的 thunk）。 */
		function labelOf(label) {
			if (typeof label === "function") {
				try {
					var value = label();
					return value === null || value === undefined ? "" : String(value);
				} catch (error) {
					return "";
				}
			}
			return typeof label === "string" ? label : "";
		}

		/**
		 * 把 settings.section 的账本条目投影成左侧栏行清单。
		 *
		 * 必须与官方外壳逐行对齐：外壳是 `entries().map(...).sort((a,b)=>a.order-b.order)`，
		 * 不做任何过滤（缺 id 的条目也会产生一行，id 为空串）。这里保持同一规则，
		 * 否则索引对齐会整体错位。
		 */
		function rowsFromEntries(entries) {
			var list = Array.isArray(entries) ? entries : [];
			var rows = [];
			for (var i = 0; i < list.length; i++) {
				var entry = list[i];
				var options = (entry && entry.options) || {};
				rows.push({
					id: typeof options.id === "string" ? options.id : "",
					label: labelOf(options.label),
					order: typeof options.order === "number" ? options.order : 0,
					registrant: typeof options.registrant === "string" ? options.registrant : "",
				});
			}
			rows.sort(function (a, b) {
				return a.order - b.order;
			});
			return rows;
		}

		/** 归一化宿主返回的分组（防御脏数据：任何非数组/非对象都退化成空）。 */
		function normalizeGroups(raw) {
			var out = { local: [], remote: [], unknown: [] };
			Object.keys(out).forEach(function (key) {
				var list = raw && Array.isArray(raw[key]) ? raw[key] : [];
				out[key] = list
					.filter(function (item) {
						return item !== null && typeof item === "object" && typeof item.id === "string" && item.id.length > 0;
					})
					.map(function (item) {
						return {
							id: item.id,
							label: typeof item.label === "string" && item.label.length > 0 ? item.label : item.id,
							order: typeof item.order === "number" ? item.order : 0,
							package: typeof item.package === "string" ? item.package : "",
							spec: typeof item.spec === "string" ? item.spec : "",
							bundle: item.bundle === true,
							disabled: item.disabled === true,
							reason: typeof item.reason === "string" ? item.reason : "",
						};
					});
			});
			return out;
		}

		/** 分组里的全部分页 id —— 也就是要从左侧栏收纳掉的那些（不含固定项）。 */
		function allGroupIds(groups) {
			var ids = [];
			["local", "remote", "unknown"].forEach(function (key) {
				var list = groups && Array.isArray(groups[key]) ? groups[key] : [];
				list.forEach(function (item) {
					if (item && typeof item.id === "string" && item.id.length > 0 && ids.indexOf(item.id) < 0) ids.push(item.id);
				});
			});
			return ids;
		}

		/** 收敛来自宿主的固定项：字符串、去空白、去重（宿主也做同样的事，这边是第二道）。 */
		function normalizePinList(input) {
			if (!Array.isArray(input)) return [];
			var out = [];
			for (var i = 0; i < input.length; i++) {
				if (typeof input[i] !== "string") continue;
				var id = input[i].trim();
				if (id === "" || out.indexOf(id) >= 0) continue;
				out.push(id);
			}
			return out;
		}

		/**
		 * 真正要从左侧栏收走的分页 = 收纳全集 − 固定项。
		 *
		 * 这条规则只在这里实现一次：固定/取消固定要立刻反映到左侧栏，不能等宿主往返，
		 * 所以界面用的是本地乐观值，宿主的 pins 只是同一份事实的持久化副本。
		 */
		function effectiveHiddenIds(hiddenIds, pins) {
			var pinned = {};
			normalizePinList(pins).forEach(function (id) {
				pinned[id] = true;
			});
			return normalizePinList(hiddenIds).filter(function (id) {
				return pinned[id] !== true;
			});
		}

		/** 当前分组里真实存在的固定项（卸载插件后残留的 id 不显示）。 */
		function pinnedItems(groups, pins) {
			var byId = {};
			["local", "remote", "unknown"].forEach(function (key) {
				var list = groups && Array.isArray(groups[key]) ? groups[key] : [];
				list.forEach(function (item) {
					if (item && typeof item.id === "string") byId[item.id] = item;
				});
			});
			var out = [];
			normalizePinList(pins).forEach(function (id) {
				if (byId[id] !== undefined) out.push(byId[id]);
			});
			return out;
		}

		/** 某个分页是否已固定。 */
		function isPinned(pins, id) {
			return normalizePinList(pins).indexOf(id) >= 0;
		}

		/**
		 * 计算「第 i 个 DOM 按钮 ↔ 第 i 行账本条目」的对应关系与收纳动作。
		 *
		 * 先按索引对齐（账本与外壳用同一次排序，正常情况下严格一一对应），
		 * 索引位的 label 与账本 label 不一致时退化为按 label 找唯一匹配。
		 * 对不上的行一律不动 DOM —— 宁可少藏一个，也不要藏错一个。
		 *
		 * @returns {Array<{index:number,id:string,hide:boolean}>}
		 */
		function planRail(rows, buttons, hiddenIds, showAll) {
			var rowList = Array.isArray(rows) ? rows : [];
			var buttonList = Array.isArray(buttons) ? buttons : [];
			var hidden = {};
			if (showAll !== true) {
				(Array.isArray(hiddenIds) ? hiddenIds : []).forEach(function (id) {
					hidden[id] = true;
				});
			}
			var used = {};
			var plan = [];
			for (var i = 0; i < rowList.length; i++) {
				var row = rowList[i];
				var index = -1;
				var aligned = i < buttonList.length ? buttonList[i] : undefined;
				if (aligned !== undefined && used[i] !== true) {
					var alignedLabel = typeof aligned.label === "string" ? aligned.label : "";
					if (row.label === "" || alignedLabel === "" || alignedLabel === row.label) index = i;
				}
				if (index < 0 && row.label !== "") {
					for (var j = 0; j < buttonList.length; j++) {
						if (used[j] === true) continue;
						if (buttonList[j] && buttonList[j].label === row.label) {
							index = j;
							break;
						}
					}
				}
				if (index < 0) continue;
				used[index] = true;
				plan.push({ index: index, id: row.id, hide: row.id !== "" && hidden[row.id] === true });
			}
			return plan;
		}
		//#endregion

		//#region DOM：弹窗 / 左侧栏按钮
		/** 当前打开着的设置弹窗，未打开时为 null。 */
		function settingsDialog() {
			if (typeof document === "undefined") return null;
			try {
				return document.querySelector(DIALOG_SELECTOR);
			} catch (error) {
				return null;
			}
		}

		/** 弹窗左侧导航里的分页按钮（官方外壳里 nav 内只有这些 button）。 */
		function navButtons() {
			var dialog = settingsDialog();
			if (dialog === null) return [];
			var nav = dialog.querySelector("nav");
			if (nav === null) return [];
			var found = nav.querySelectorAll("button");
			var nodes = [];
			for (var i = 0; i < found.length; i++) nodes.push(found[i]);
			return nodes;
		}

		/** 读按钮上的分页名（`.navLabel` 在官方外壳里是按钮唯一的 span 子节点）。 */
		function buttonLabel(node) {
			if (node === null || node === undefined) return "";
			var span = null;
			try {
				span = node.querySelector(":scope > span");
			} catch (error) {
				span = null;
			}
			if (span === null) {
				var children = node.children || [];
				for (var i = 0; i < children.length; i++) {
					if (children[i].tagName === "SPAN") {
						span = children[i];
						break;
					}
				}
			}
			var text = span !== null && span !== undefined ? span.textContent : node.textContent;
			return (text || "").trim();
		}

		/**
		 * 把当前快照投影到左侧栏：给按钮打上分页 id 标记，并按「收纳全集 − 固定项」隐藏。
		 * 每轮先清掉上一轮的标记再重放，保证是幂等的（不会留下半隐藏状态）。
		 */
		function applyRail() {
			var nodes = navButtons();
			if (nodes.length === 0) return 0;
			var snapshot = getState();
			var buttons = nodes.map(function (node) {
				return { label: buttonLabel(node) };
			});
			// 先确认这确实是设置弹窗的左侧栏，再动 DOM（别的 dialog 一律不碰）。
			if (!isSettingsRail(buttons)) return 0;
			for (var i = 0; i < nodes.length; i++) {
				var node = nodes[i];
				if (node.getAttribute(ATTR_HIDDEN) !== null) {
					node.style.display = "";
					node.removeAttribute(ATTR_HIDDEN);
				}
				node.removeAttribute(ATTR_SECTION);
			}
			var hidden = effectiveHiddenIds(snapshot.hiddenIds, snapshot.pins);
			var plan = planRail(snapshot.sections, buttons, hidden, snapshot.showAll);
			for (var k = 0; k < plan.length; k++) {
				var step = plan[k];
				var target = nodes[step.index];
				if (target === undefined) continue;
				target.setAttribute(ATTR_SECTION, step.id);
				if (step.hide) {
					target.style.display = "none";
					target.setAttribute(ATTR_HIDDEN, "1");
				}
			}
			return plan.length;
		}

		/** 分页 id 只允许安全字符，避免拼出畸形选择器。 */
		function safeId(id) {
			return typeof id === "string" && /^[A-Za-z0-9_.:-]+$/.test(id) ? id : null;
		}

		/**
		 * 这个 nav 是不是设置弹窗的左侧栏？
		 *
		 * 页面上可能同时存在别的 `[role=dialog][aria-modal=true]`。判据取一条最强的：
		 * 里面必须有本插件自己那一行（标题是写死的字面量，不受语言影响）。
		 * 不是设置左侧栏就整轮不动 DOM —— 少藏一次没有任何损失。
		 */
		function isSettingsRail(buttons) {
			for (var i = 0; i < buttons.length; i++) {
				if (buttons[i] !== null && buttons[i] !== undefined && buttons[i].label === HUB_TITLE) return true;
			}
			return false;
		}

		/**
		 * 替用户点名那个被收纳的原生分页按钮 —— 官方外壳随后照常渲染它的页面。
		 * @returns {boolean} 是否成功点到。
		 */
		function openSection(id) {
			var key = safeId(id);
			if (key === null) return false;
			var dialog = settingsDialog();
			if (dialog === null) return false;
			var selector = "button[" + ATTR_SECTION + '="' + key + '"]';
			var node = dialog.querySelector(selector);
			if (node === null) {
				applyRail();
				node = dialog.querySelector(selector);
			}
			if (node === null) return false;
			node.click();
			return true;
		}
		//#endregion

		//#region 与宿主对话
		/** 上报账本，换取「哪些分页被收纳、分别来自哪里」。 */
		function resolveNow(scope) {
			var entries = [];
			try {
				entries = scope.slots.entries("settings.section") || [];
			} catch (error) {
				entries = [];
			}
			var rows = rowsFromEntries(entries);
			setState({ sections: rows });
			if (rows.length === 0) {
				// 账本还没声明/已清空：不藏任何东西，等下一次账本变化再解析。
				setState({ status: "loading", error: "", hiddenIds: [], groups: { local: [], remote: [], unknown: [] } });
				applyRail();
				return;
			}
			var payload = JSON.stringify({ sections: rows });
			var options = {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: payload,
			};
			options.headers[ACTION_HEADER] = "resolve";
			fetch(API_BASE + "/resolve", options)
				.then(function (response) {
					return response.json().then(function (body) {
						return { status: response.status, body: body };
					});
				})
				.then(function (result) {
					var body = result.body;
					if (body === null || typeof body !== "object" || body.ok !== true) {
						var reason = body && typeof body.error === "string" && body.error.length > 0 ? body.error : "HTTP " + result.status;
						throw new Error(reason);
					}
					var groups = normalizeGroups(body.groups);
					var hidden = Array.isArray(body.hiddenIds) && body.hiddenIds.length > 0 ? body.hiddenIds.slice() : allGroupIds(groups);
					setState({
						status: "ready",
						error: "",
						groups: groups,
						hiddenIds: hidden,
						pins: normalizePinList(body.pins),
						pinsUpdatedAt: typeof body.pinsUpdatedAt === "number" ? body.pinsUpdatedAt : 0,
						pinsError: typeof body.pinsError === "string" ? body.pinsError : "",
						resolvedAt: Date.now(),
					});
					applyRail();
				})
				.catch(function (error) {
					// 读不到来源就一个都不藏：左侧栏保持原生，收纳页里如实说明。
					setState({
						status: "error",
						error: error && error.message ? String(error.message) : String(error),
						groups: { local: [], remote: [], unknown: [] },
						hiddenIds: [],
						resolvedAt: Date.now(),
					});
					applyRail();
				});
		}

		/** 把固定项写回宿主（唯一的写操作）。 */
		function putPins(pins) {
			var options = {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ pins: pins }),
			};
			options.headers[ACTION_HEADER] = "pins";
			return fetch(API_BASE + "/pins", options)
				.then(function (response) {
					return response.json().then(function (body) {
						return { status: response.status, body: body };
					});
				})
				.then(function (result) {
					var body = result.body;
					if (body === null || typeof body !== "object" || body.ok !== true) {
						var reason = body && typeof body.error === "string" && body.error.length > 0 ? body.error : "HTTP " + result.status;
						throw new Error(reason);
					}
					return body;
				});
		}

		/**
		 * 固定 / 取消固定一个分页。
		 *
		 * 乐观更新：先本地翻转并立刻重放左侧栏，再落盘；落盘失败就整体回退到上一次
		 * 成功的固定集合，并把原因写在收纳页上 —— 屏幕上的左侧栏永远不该出现
		 * 「看起来固定了、刷新后又回来」的假象。
		 * 写入期间按钮禁用（pinsBusy），避免两次相邻点击互相覆盖。
		 */
		function togglePinned(id) {
			var snapshot = getState();
			if (snapshot.status !== "ready" || snapshot.pinsBusy === true) return;
			if (typeof id !== "string" || id.trim() === "") return;
			var previous = normalizePinList(snapshot.pins);
			var next = previous.indexOf(id) >= 0
				? previous.filter(function (entry) {
					return entry !== id;
				})
				: previous.concat([id]);
			setState({ pins: next, pinsBusy: true, pinsNotice: "", pinsError: "" });
			applyRail();
			putPins(next)
				.then(function (body) {
					setState({
						pins: normalizePinList(body.pins),
						pinsBusy: false,
						pinsUpdatedAt: typeof body.updatedAt === "number" ? body.updatedAt : 0,
						pinsNotice: typeof body.dropped === "number" && body.dropped > 0 ? "宿主忽略了 " + body.dropped + " 条无效项" : "",
					});
					applyRail();
				})
				.catch(function (error) {
					setState({
						pins: previous,
						pinsBusy: false,
						pinsError: "固定设置没能保存：" + (error && error.message ? String(error.message) : String(error)),
					});
					applyRail();
				});
		}

		var resolveTimer = null;
		function scheduleResolve(scope, delay) {
			if (resolveTimer !== null) clearTimeout(resolveTimer);
			resolveTimer = setTimeout(function () {
				resolveTimer = null;
				resolveNow(scope);
			}, typeof delay === "number" ? delay : RESOLVE_DEBOUNCE_MS);
		}
		//#endregion

		//#region 左侧栏观察器（与收纳页是否激活无关）
		/**
		 * 设置弹窗随时可能被打开/关闭、React 也可能重建导航按钮，所以收纳动作
		 * 挂在文档级观察器上，而不是挂在收纳页组件里（组件只在收纳页激活时存在）。
		 */
		function installRailWatcher() {
			if (typeof document === "undefined" || typeof window === "undefined") return function () {};
			var scheduled = null;
			var sweep = null;
			var schedule = function () {
				if (scheduled !== null) return;
				scheduled = window.setTimeout(function () {
					scheduled = null;
					applyRail();
				}, 0);
			};
			schedule();
			var observer = null;
			if (typeof window.MutationObserver === "function") {
				observer = new window.MutationObserver(function () {
					schedule();
				});
				observer.observe(document.body, { childList: true, subtree: true });
			}
			sweep = window.setInterval(function () {
				if (settingsDialog() !== null) applyRail();
			}, RAIL_SWEEP_MS);
			return function () {
				if (scheduled !== null) window.clearTimeout(scheduled);
				if (sweep !== null) window.clearInterval(sweep);
				if (observer !== null) observer.disconnect();
				// 卸载即还原：把左侧栏交还给原生形状。
				var nodes = navButtons();
				for (var i = 0; i < nodes.length; i++) {
					if (nodes[i].getAttribute(ATTR_HIDDEN) !== null) {
						nodes[i].style.display = "";
						nodes[i].removeAttribute(ATTR_HIDDEN);
					}
					nodes[i].removeAttribute(ATTR_SECTION);
				}
			};
		}
		//#endregion

		//#region 样式
		var CSS = [
			".hub-root{display:flex;flex-direction:column;gap:16px;padding:2px 2px 24px;color:inherit}",
			".hub-title{margin:0;font-size:16px;font-weight:600;line-height:24px}",
			".hub-desc{margin:6px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,1))}",
			".hub-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
			".hub-btn{font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:8px;cursor:pointer;border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit}",
			".hub-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
			".hub-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,1))}",
			".hub-error{margin:0;font-size:12px;line-height:18px;color:#d4380d}",
			".hub-group{display:flex;flex-direction:column;gap:8px}",
			".hub-group-title{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,1))}",
			".hub-list{list-style:none;margin:0;padding:0;display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}",
			".hub-item{display:flex;align-items:center;gap:4px;padding:6px 8px 6px 4px;border-radius:12px;border:1px solid rgba(127,127,127,.24);background:transparent;color:inherit}",
			".hub-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
			".hub-item.is-pinned{border-color:rgba(22,119,255,.45)}",
			".hub-item-open{flex:1;min-width:0;display:flex;align-items:center;gap:10px;text-align:left;font:inherit;cursor:pointer;padding:4px 6px;border:none;border-radius:8px;background:transparent;color:inherit}",
			".hub-item-pin{flex:none;font:inherit;font-size:11px;line-height:16px;padding:2px 8px;border-radius:999px;cursor:pointer;border:1px solid rgba(127,127,127,.32);background:transparent;color:var(--dsw-alias-label-secondary,rgba(127,127,127,1))}",
			".hub-item-pin:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
			".hub-item-pin.is-on{border-color:rgba(22,119,255,.5);background:rgba(22,119,255,.14);color:#1677ff}",
			".hub-item-pin:disabled{opacity:.5;cursor:default}",
			".hub-item-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
			".hub-item-name{font-size:13px;font-weight:500;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".hub-item-pkg{font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,rgba(127,127,127,1))}",
			".hub-badge{flex:none;font-size:11px;line-height:16px;padding:1px 8px;border-radius:999px;border:1px solid transparent}",
			".hub-badge-local{background:rgba(82,196,26,.16);color:#389e0d;border-color:rgba(82,196,26,.32)}",
			".hub-badge-remote{background:rgba(22,119,255,.14);color:#1677ff;border-color:rgba(22,119,255,.3)}",
			".hub-badge-unknown{background:rgba(250,173,20,.16);color:#d48806;border-color:rgba(250,173,20,.34)}",
			".hub-item-arrow{flex:none;font-size:14px;line-height:16px;opacity:.45}",
			".hub-pinned{gap:6px}",
			".hub-chips{display:flex;flex-wrap:wrap;gap:6px}",
			".hub-chip{display:inline-flex;align-items:center;gap:2px;padding:2px 4px 2px 10px;border-radius:999px;border:1px solid rgba(22,119,255,.4);background:rgba(22,119,255,.12);font-size:12px;line-height:20px}",
			".hub-chip-remove{border:none;border-radius:999px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:0 5px}",
			".hub-chip-remove:hover{background:rgba(127,127,127,.2)}",
			".hub-chip-remove:disabled{opacity:.5;cursor:default}",
		].join("");

		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin="dsh-settings-plugin-hub"]') !== null) return;
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-settings-plugin-hub";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region 收纳页组件
		/** 订阅外部 store 的极简 hook（不依赖 useSyncExternalStore 的版本差异）。 */
		function useHubState() {
			var pair = react.useState(getState());
			var setSnapshot = pair[1];
			react.useEffect(function () {
				setSnapshot(getState());
				return subscribe(function () {
					setSnapshot(getState());
				});
			}, []);
			return pair[0];
		}

		/** 一张分页卡片：主体点击→点亮被收纳的原生分页按钮；右侧按钮→固定/取消固定。 */
		function HubItem(props) {
			var item = props.item;
			var pinned = props.pinned === true;
			var onClick = function () {
				var opened = openSection(item.id);
				if (!opened) {
					setState({ resolveError: "暂时没找到这个分页的原生按钮，请点「重新识别」后重试，或先「临时显示全部分页」。" });
					return;
				}
				setState({ resolveError: "" });
			};
			var badgeClass = "hub-badge hub-badge-" + (props.group === "local" ? "local" : props.group === "remote" ? "remote" : "unknown");
			var subtitle = item.package !== "" ? item.package + (item.spec !== "" ? " · " + item.spec : "") : "未匹配到 profile 里已安装的包";
			return h(
				"li",
				{ key: item.id, className: "hub-item" + (pinned ? " is-pinned" : "") },
				h(
					"button",
					{ type: "button", className: "hub-item-open", onClick: onClick, title: subtitle },
					h(
						"span",
						{ className: "hub-item-main" },
						h("span", { className: "hub-item-name" }, item.label),
						h("span", { className: "hub-item-pkg" }, subtitle),
					),
					h("span", { className: badgeClass }, props.badge),
					h("span", { className: "hub-item-arrow" }, "›"),
				),
				h(
					"button",
					{
						type: "button",
						className: "hub-item-pin" + (pinned ? " is-on" : ""),
						onClick: function () {
							togglePinned(item.id);
						},
						"aria-pressed": pinned ? "true" : "false",
						disabled: props.pinDisabled === true,
						title: pinned ? "取消固定：重新收进本页" : "固定到设置左侧栏，单独占一行",
					},
					pinned ? "已固定" : "固定",
				),
			);
		}

		/**
		 * 手工选择区：列出已固定到左侧栏的分页。
		 * 位置刻意紧跟在「临时显示全部分页」之后 —— 前者是一次性全显示，
		 * 这里才是持久化的逐条选择。
		 *
		 * 一个都没有时整块不渲染（连标题也不渲染）：空着的「固定在左侧栏显示 · 0」加一句
		 * 教学提示只是白占一行。发现路径交给每张卡片右侧那颗「固定」按钮，以及页面顶部
		 * 那句说明里的提示，所以隐藏它不牺牲可发现性。
		 *
		 * 「固定设置已保存：…」由调用方经 notice 传进来，渲染在本块最后一行（说明之下）：
		 * 它是对这一块内容的写盘回执，跟着这一块走而不是飘在页面顶端。
		 */
		function PinnedPicker(props) {
			var items = Array.isArray(props.items) ? props.items : [];
			if (items.length === 0) return null;
			var disabled = props.disabled === true;
			var notice = typeof props.notice === "string" ? props.notice : "";
			return h(
				"section",
				{ className: "hub-group hub-pinned" },
				h("h3", { className: "hub-group-title" }, "固定在左侧栏显示 · " + items.length),
				h(
					"div",
					{ className: "hub-chips" },
					items.map(function (item) {
						return h(
							"span",
							{ className: "hub-chip", key: item.id },
							h("span", { className: "hub-chip-label" }, item.label),
							h(
								"button",
								{
									type: "button",
									className: "hub-chip-remove",
									onClick: function () {
										togglePinned(item.id);
									},
									disabled: disabled,
									"aria-label": "取消固定 " + item.label,
									title: "取消固定",
								},
								"×",
							),
						);
					}),
				),
				h("p", { className: "hub-note" }, "这些分页不受收纳影响，会单独出现在设置左侧栏里；点「×」把它们收回本页。"),
				notice !== "" ? h("p", { className: "hub-note" }, notice) : null,
			);
		}

		/** 一个分组（本地/非本地/未识别），空组不渲染。 */
		function HubGroup(props) {
			var items = props.items;
			if (!Array.isArray(items) || items.length === 0) return null;
			return h(
				"section",
				{ className: "hub-group" },
				h("h3", { className: "hub-group-title" }, GROUP_TITLES[props.group] + " · " + items.length),
				h(
					"ul",
					{ className: "hub-list" },
					items.map(function (item) {
						return h(HubItem, {
							key: item.id,
							item: item,
							group: props.group,
							badge: props.badge,
							pinned: props.pins.indexOf(item.id) >= 0,
							pinDisabled: props.pinDisabled === true,
						});
					}),
				),
			);
		}

		/** 设置侧栏「第三方插件」页：左侧栏被收纳分页的总入口。 */
		function HubSection() {
			var snapshot = useHubState();
			var groups = snapshot.groups;
			var total = groups.local.length + groups.remote.length + groups.unknown.length;
			var refresh = function () {
				setState({ status: "loading", error: "" });
				var scope = activeScope;
				if (scope === null) {
					setState({ status: "error", error: "slots 服务不可用" });
					return;
				}
				scheduleResolve(scope, 0);
			};
			var toggleShowAll = function () {
				setState({ showAll: snapshot.showAll !== true });
				applyRail();
			};
			var statusLine = null;
			var pinned = pinnedItems(groups, snapshot.pins);
			var hiddenNow = effectiveHiddenIds(snapshot.hiddenIds, snapshot.pins).length;
			if (snapshot.status === "error") {
				statusLine = h("p", { className: "hub-error" }, "读不到安装来源（" + snapshot.error + "）：已保持原生左侧栏，一个分页都没有收纳。");
			} else if (snapshot.status === "loading") {
				statusLine = h("p", { className: "hub-note" }, "正在识别安装来源…");
			} else {
				statusLine = h("p", { className: "hub-note" },
					"左侧栏已收纳 " + hiddenNow + " 个第三方分页" +
						(pinned.length > 0 ? "，" + pinned.length + " 个已固定单独显示" : "") +
						(snapshot.showAll === true ? "（当前临时全部显示）" : "") +
						(snapshot.resolvedAt > 0 ? "，识别于 " + new Date(snapshot.resolvedAt).toLocaleTimeString() : ""));
			}
			var pinDisabled = snapshot.status !== "ready" || snapshot.pinsBusy === true;
			// 固定数为 0 时整块「固定」区域不渲染（详见 PinnedPicker）。发现路径交给卡片右侧
			// 的「固定」按钮与上面那句说明。写入中 / 写失败的提示不受这条规则影响：
			// 它们说的是「你刚才那次操作出问题了」，跟当前有没有固定项无关。
			// 写盘回执跟着那块内容走：传进 PinnedPicker 渲染在说明之下（页面顶端不再有它）；
			// 固定项为空时 PinnedPicker 自己返回 null，这行回执自然也不出现。
			var saveNotice = snapshot.pinsError === "" && snapshot.pinsBusy !== true && snapshot.pinsUpdatedAt > 0
				? "固定设置已保存：" + new Date(snapshot.pinsUpdatedAt).toLocaleString()
				: "";
			return h(
				"div",
				{ className: "hub-root" },
				h(
					"header",
					null,
					h("h2", { className: "hub-title" }, HUB_TITLE),
					h("p", { className: "hub-desc" },
						"所有第三方插件注册的设置分页都收在这里：左侧栏只留一个入口，按安装来源分组。" +
							"点卡片即进入该插件的原生设置页；想让某个分页单独留在左侧栏，点它右侧的「固定」。" +
							"跳转后点左侧栏的「" + HUB_TITLE + "」即可返回。"),
				),
				h(
					"div",
					{ className: "hub-toolbar" },
					h("button", { type: "button", className: "hub-btn", onClick: refresh }, "重新识别"),
					h("button", { type: "button", className: "hub-btn", onClick: toggleShowAll },
						snapshot.showAll === true ? "恢复收纳" : "临时显示全部分页"),
					h("span", { className: "hub-note" }, total > 0 ? "共 " + total + " 个" : ""),
				),
				statusLine,
				snapshot.resolveError !== "" ? h("p", { className: "hub-error" }, snapshot.resolveError) : null,
				snapshot.pinsNotice !== "" ? h("p", { className: "hub-note" }, snapshot.pinsNotice) : null,
				snapshot.pinsError !== "" ? h("p", { className: "hub-error" }, snapshot.pinsError) : null,
				h(PinnedPicker, { items: pinned, disabled: pinDisabled, notice: saveNotice }),
				h(HubGroup, { group: "local", items: groups.local, badge: "本地", pins: snapshot.pins, pinDisabled: pinDisabled }),
				h(HubGroup, { group: "remote", items: groups.remote, badge: "远程", pins: snapshot.pins, pinDisabled: pinDisabled }),
				h(HubGroup, { group: "unknown", items: groups.unknown, badge: "未知", pins: snapshot.pins, pinDisabled: pinDisabled }),
				snapshot.status === "ready" && total === 0
					? h("p", { className: "hub-note" }, "当前没有需要收纳的第三方分页：安装带设置页的插件后，它会自动出现在这里。")
					: null,
			);
		}
		//#endregion

		/** 当前 slots 作用域（收纳页的「重新识别」按钮要用它读账本）。 */
		var activeScope = null;

		/**
		 * 浏览器插件入口。
		 * @param {object} ctx - 客户端 cordis 上下文（提供 slots 服务）。
		 */
		function apply(ctx) {
			installStyles();
			ctx.inject(["slots"], function (scope) {
				activeScope = scope;
				scope.slots.inject("settings.section", function () {
					return scope.slots.register(
						{ name: "settings.section", id: SECTION_ID, order: 1000, label: function () { return HUB_TITLE; } },
						HubSection,
					);
				});
				scope.effect(function () {
					var off = scope.slots.subscribe("settings.section", function () {
						scheduleResolve(scope, RESOLVE_DEBOUNCE_MS);
					});
					return function () {
						off();
					};
				}, "settings-plugin-hub: settings.section ledger");
				scheduleResolve(scope, 0);
				scope.effect(function () {
					applyRail();
				}, "settings-plugin-hub: first rail pass");
			});
			ctx.effect(installRailWatcher, "settings-plugin-hub: rail watcher");
		}

		exports.name = "dsh-settings-plugin-hub-client";
		exports.apply = apply;
		/** 单测接口：纯逻辑 + store + DOM 动作（不改变运行时语义）。 */
		exports.__internals = {
			SECTION_ID: SECTION_ID,
			ATTR_SECTION: ATTR_SECTION,
			ATTR_HIDDEN: ATTR_HIDDEN,
			labelOf: labelOf,
			rowsFromEntries: rowsFromEntries,
			normalizeGroups: normalizeGroups,
			allGroupIds: allGroupIds,
			normalizePinList: normalizePinList,
			effectiveHiddenIds: effectiveHiddenIds,
			pinnedItems: pinnedItems,
			isPinned: isPinned,
			putPins: putPins,
			togglePinned: togglePinned,
			planRail: planRail,
			buttonLabel: buttonLabel,
			safeId: safeId,
			isSettingsRail: isSettingsRail,
			settingsDialog: settingsDialog,
			navButtons: navButtons,
			getState: getState,
			setState: setState,
			subscribe: subscribe,
			applyRail: applyRail,
			openSection: openSection,
			resolveNow: resolveNow,
			scheduleResolve: scheduleResolve,
			installRailWatcher: installRailWatcher,
			HubSection: HubSection,
			PinnedPicker: PinnedPicker,
		};
		return module.exports;
	},
});
