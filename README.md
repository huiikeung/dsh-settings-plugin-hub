# dsh-settings-plugin-hub

DeepSeek Harness Web profile 插件：**设置左侧栏收纳 + 手工固定**。

装上插件之后，设置弹窗的左侧导航栏只多出一个入口「**第三方插件**」——所有第三方插件
注册的设置分页（`settings.section`）都从左侧栏收走，集中在这一页里，按安装来源分成
**本地安装 / 非本地安装 / 来源未识别** 三组。点其中一张卡片，进的就是那个插件的原生设置页
（不是复制品，是它自己）。

收纳不是一刀切：卡片右侧的「**固定**」按钮可以把任意分页单独留在左侧栏（跨重启、跨浏览器
生效）。所以「左栏清爽」和「常用分页少点一次」可以同时要。

内置分页（通用 / 模型 / 内置插件 / Agent 预设 / 归档会话）保持在原生位置不动。

```
设置
├─ 通用
├─ 模型
├─ 内置插件
├─ Agent 预设
├─ 归档会话
├─ 视觉助手           ← 手工固定：重新单独占一行
└─ 第三方插件          ← 唯一保留的第三方入口
     ├─ 固定在左侧栏显示 · 1        [视觉助手 ×]
     ├─ 本地安装 · 2
     │   界面增强    (dsh-better-display · link:dsh-better-display)
     │   视觉助手    (dsh-vision-assistant · link:dsh-vision-assistant)   [已固定]
     ├─ 非本地安装 · 7
     │   用量计费 / 插件市场 / 皮肤 / 记忆 / 归档聊天 / 插件能力 / 辅助
     └─ 来源未识别 · 0
```

## 工作原理

第三方插件的分页是它们**自己 fiber 里的注册**：slot 账本不允许别的插件撤销或改写别人的条目
（`ctx.slots` 没有跨插件 remove，`renderSlot` 也只能渲染自己声明过的子 slot）。所以本插件
不去动注册，而是做两件互补的事：

1. **收纳左侧栏**：挂一个文档级 `MutationObserver`，把左侧栏里属于第三方、且**没有被固定**的
   分页按钮按账本顺序与 `settings.section` 条目对齐，打上 `data-dsh-hub-section="<id>"` 并
   `display:none`。元素留在 DOM 里，React 每次重建按钮后观察器都会重放一遍；插件卸载时全部还原。
   *（观察器挂在插件级 effect 上，而不是挂在收纳页组件里——组件只在收纳页被激活时存在，
   而左侧栏需要在设置弹窗一打开就干净。）*
2. **点击代理**：收纳页里的卡片点击时，向那个被隐藏的原生按钮派发 `click`。官方设置外壳
   照常完成 `activeId` 切换与内容渲染，因此第三方分页的生命周期、关闭、路由行为一字未改。

左侧栏里到底哪些按钮属于第三方，由宿主半边判定（见下），**没匹配上就不藏**：宁可少藏一个，
也不会藏错一个。

### 固定在左侧栏显示

收纳是默认，固定是显式例外。

- 位置：工具栏的「临时显示全部分页」**后面**就是手工选择区。前者是一次性全显示，这里是
  持久化的逐条选择；卡片右侧的「固定 / 已固定」按钮直接改这份名单。
  这一块自下而上的顺序是：标题 → 已固定分页的卡片（点「×」取消）→ 说明一句 →
  **写盘回执「固定设置已保存：…」**（它在说明之下，是对这一块的写盘回执，
  不飘在页面顶端）。
- **固定数为 0 时整块不渲染**：标题「固定在左侧栏显示 · 0」、空状态提示、以及
  「固定设置已保存」那一行都不显示，下面直接就是分组列表（分组列表永远可见——
  不然没法固定第一个）。发现路径留给每张卡片右侧那颗「固定」按钮，以及页面说明里的那一句。
  取消最后一个的瞬间也会立刻隐藏。写盘失败的红色提示不受这条规则影响：它说的是
  「你刚才那次操作出问题了」，与当前有没有固定项无关。- 存哪：`$DSH_HOME/plugin-data/dsh-settings-plugin-hub/pins.json`，按 profile 分桶。
  写成给人看懂的 JSON，先写 `.tmp` 再 rename（原子写，不会留下半截文件）：
  ```json
  { "version": 1, "profiles": { "web": { "pins": ["vision"], "updatedAt": 1760000000000 } } }
  ```
- 生效：点「固定」立刻在本地翻转并重放左侧栏（不等往返）；随后写盘。**写盘失败就整体回退**
  到上一次成功的名单并写明原因，屏幕上不会出现「看起来固定了、刷新后又回来」的假象。
  写入期间按钮禁用，避免两次相邻点击互相覆盖。
- 固定项里残留的 id（插件已卸载）不会显示、也不影响收纳，更不会把那一块「撑」出来；
  读不到安装来源时，固定按钮禁用（此时一个分页都没收纳，无从固定）。

### 来源与固定项是怎么来的

浏览器读不到 profile 的依赖清单、也不该直接写盘，所以宿主半边（`lib/index.js`）提供：

| 端点 | 作用 |
|---|---|
| `GET /settings-plugin-hub/inventory` | 当前 profile 装了哪些包、来自哪里、每个包注册了哪些分页 |
| `POST /settings-plugin-hub/resolve` | 浏览器上报左侧栏分页清单 → 分组结果 + 已保存的固定项 |
| `GET /settings-plugin-hub/pins` | 读「固定在左侧栏显示」白名单 |
| `PUT /settings-plugin-hub/pins` | 写白名单（唯一的写操作） |

`resolve` 返回的 `hiddenIds` 是**收纳全集**；浏览器半边用本地固定项把它减成真正要藏的那批
（`effectiveHiddenIds`），这样固定/取消才能即时反映到左侧栏。

判定规则（`lib/inventory.js`）：

- `link:` / `file:` / 绝对路径 / `workspace:` ⇒ **本地**；语义化版本 / `github:` / tarball ⇒ **非本地**；
  另外用 `node_modules/<pkg>` 的 realpath 做第二判据（pnpm 把 `link:` 物化成指向 profile 之外的软链）。
- 每个包注册了哪些分页，是从它自己的客户端 bundle 里读 `settings.section` 的 `id` 得到的
  （同时兼容手写与压缩两种写法）。
- 同一个分页 id 被多个包抢注时（例如 `vision` 同时属于 `dsh-vision-assistant` 与已停用的
  `dsh-vision-opencode`），优先用 `registrant`（客户端 Loader 的 fiber 名）匹配，其次排除
  profile `cordis.patch.yml` 里被停用的包。
- 归属不到任何已安装包的分页落进「来源未识别」，**仍然会被收纳**，只是来源不打标。

所有端点都要求动作头 `x-settings-plugin-hub-action`（`webServer` 路由不带浏览器会话鉴权，
自定义头挡得住跨站表单/图片标签）。应答里不含任何机器绝对路径：`link:/vol1/.../dsh-x`
一律折叠成 `link:dsh-x`。

## 安装

```sh
cd /vol1/1000/Deepseek-Harness/工作台/插件/dsh-settings-plugin-hub
node scripts/install-profile.mjs --dry-run   # 先看要改什么
node scripts/install-profile.mjs             # 真装（会先备份 profile/package.json）
```

然后**重启 dsh**（宿主半边要注册 HTTP 端点，浏览器半边要进客户端模块图），再打开
设置 → 第三方插件。

官方 CLI 的等价做法：

```sh
dsh plugin --profile web add -w dsh-settings-plugin-hub@link:/vol1/1000/Deepseek-Harness/工作台/插件/dsh-settings-plugin-hub
```

profile 目录默认取 `$DSH_HOME/profiles/web`，可用 `DSH_PROFILE_DIR=<目录>` 覆盖。

### 从 GitHub 安装（远程，指定 tag）

不用先克隆，直接让 pnpm 从仓库拿：

```sh
# 装 tag 指向的快照（推荐：版本可复现）
dsh plugin --profile web add -w dsh-settings-plugin-hub@github:huiikeung/dsh-settings-plugin-hub#v0.2.2

# 或跟随 main 最新
dsh plugin --profile web add -w dsh-settings-plugin-hub@github:huiikeung/dsh-settings-plugin-hub
```

装完同样**重启 dsh**。两种安装方式的取舍：

| 安装方式 | 适合 |
|---|---|
| `link:` 本地目录 | 你要改代码 / 让它跟着工作区一起演进（客户端改动刷新即生效，服务端改动重启） |
| `github:#tag` | 换机器、重装，或想要一份冻结、可复现的版本（本地改了不会生效） |

本包**没有构建步骤**（`lib/*.js` 就是产物，手写 JS），所以从 git 安装不需要 pnpm 放行
任何构建脚本；仓库里也不含 `node_modules` 或任何生成物。

实测（在临时 profile 里跑的探针，未动现有安装）：上面第一条命令一次就同时写了
`dependencies` 与 `dsh.profile.bundles` —— 也就是说**装完就是启用状态**，重启 dsh 即生效，
不需要再去「设置 → 插件」里手动启用组合包；`node_modules/dsh-settings-plugin-hub/lib/`
里四个文件齐全。

两个小坑：

- `-w`（工作区根）要求该 profile 是 pnpm 工作区。DSH 生成的 profile 都是
  （目录里有 `pnpm-workspace.yaml`）；如果你手工搭了个裸 profile，去掉 `-w` 即可。
- 国内网络走 GitHub 可能很慢或超时（HTTPS 尤其不稳，SSH 反而正常）。慢的话可以先
  `git clone` 到本地，再用上面的 `link:` 方式装。

### 从 npm registry 安装（可选，需要先发布）

包名 `dsh-settings-plugin-hub` 在 npm 上**还没有被占用**，本包也已去掉
`private` 字段、可以发布。要发到公共 registry：

```sh
npm login --registry=https://registry.npmjs.org   # 本机 .npmrc 指向的是 npmmirror 镜像，不能用来发布
npm publish --registry=https://registry.npmjs.org
```

发布后即可：

```sh
dsh plugin --profile web add -w dsh-settings-plugin-hub@0.2.2
```

（注意：`npmmirror` 是只读镜像，只能装不能发。发布这一步需要你自己的 npm 账号和
token —— 我这边没有凭据，所以没有替你发。）

### 上架到插件市场列表（awesome-dsh-plugin / dsh-market）

先说清机制，免得找错地方：

- **市场（dshmarket）自己不发列表**。它每次打开都实时拉
  [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
  发布的 `plugins.json`（可用 `DSHM_REGISTRY_URL` 换镜像）。
- **市场装插件也不是自己跑 pnpm**，而是**重新调用官方 DSH CLI**：市场仓库的
  `lib/dsh-cli.js` 里 `runDshPlugin()` 会 spawn
  `<node> <当前 dsh 入口> plugin --profile <name> add <spec>`（外加 PATH、git 提示抑制、
  进度转发等处理）。官方 CLI 负责 bundle 层合并与 `allowBuilds` 授权，所以市场里的安装
  和你手敲命令**是同一条路径**。「我的插件」面板（`dsh-my-plugins`）同样是 spawn 官方 CLI。

所以「提交到市场」= 往 awesome-dsh-plugin **提一个文件**：

1. 用备好的条目（路径、文件名都别改）：
   [`market/huiikeung__dsh-settings-plugin-hub.yml`](market/huiikeung__dsh-settings-plugin-hub.yml)
2. 在 awesome-dsh-plugin 里放到 `data/plugins/huiikeung__dsh-settings-plugin-hub.yml`，
   提 PR。**一个 PR 最多 3 条**；两个 README 由脚本生成，**不要手改**（也不要手写 `npm:` 字段，
   会被校验拒绝——npm 映射是自动采集的）。
3. 收录门槛（CI 自动查）：仓库里有 `package.json` 声明 `dsh.bundle` ✅、仓库存在且未归档 ✅、
   不是 DSH 本体 ✅、**仓库年龄 ≥ 1 天**。不满足年龄时 CI 会红，但那条检查每 6 小时自动重跑，
   **不用重提 PR**，约 24 小时后自己变绿。

收录与是否发 npm 无关；发了 npm 市场才会显示下载量。本条目已用他们仓库自己的校验器
（`scripts/lib/entries.mjs` 的 `validateEntries`）验过：文件名 slug、分类 id（`ui`）、
`description.en` 必填且单行、含 `: ` 的值加引号 —— 全部通过。

不想手工 fork / 建分支 / 对齐文件名，就用仓库里的提交脚本（**默认 dry-run，不碰网络**）：

```sh
node scripts/submit-market-listing.mjs          # 只打印会做什么
gh auth login                                   # 只需一次（脚本用 gh 建 fork 与 PR）
node scripts/submit-market-listing.mjs --yes    # fork → 建分支 → 放条目 → commit → push → 提 PR
```

它在一个临时目录里克隆你的 fork、只加 `data/plugins/<owner>__<repo>.yml` 这一个文件，
不碰你的工作区；失败会把 gh/git 的原始输出贴出来。

### 配置

`cordis.patch.yml` 里都可省：

```yaml
- insert:
    - id: settings-plugin-hub
      name: 'dsh-settings-plugin-hub'
      config:
        profile: web                       # 读哪个 profile 的依赖清单（默认 web）
        # profileDir: /abs/path/to/profile # 显式指定 profile 目录，跳过自动解析
        # dataDir: /abs/path/to/dsh-home   # 显式指定 DSH 数据根目录（固定项落在这里）
```

## 使用

- **重新识别**：重读账本与宿主清单（新装插件后一般无需手动点，账本一变就会自动重解析）。
- **临时显示全部分页**：这一次会话内把左侧栏还原成原生形状（不用担心某个分页找不到），
  再点一下恢复收纳。它是临时开关，不写盘。
- **固定在左侧栏显示**：在任意卡片右侧点「固定」逐条挑选要单独留在左栏的分页，
  已固定的会出现在「固定在左侧栏显示」那一块里（固定数为 0 时这块整个不显示）。
  这是持久的，重启 dsh 后依然生效。
- 进了某个插件的原生页之后，点左侧栏的「第三方插件」即可返回分组页。
- 若某张卡片点击后没跳转（按钮对齐失败），页面会提示你点「重新识别」或「临时显示全部分页」。

## 开发与测试

```sh
cd /vol1/1000/Deepseek-Harness/工作台/插件/dsh-settings-plugin-hub
npm test          # = node --test tests/*.test.mjs
```

106 个测试，分七层：

| 文件 | 覆盖 |
|---|---|
| `tests/inventory.test.mjs` | spec 归类、bundle 分页 id 提取、registrant 归一化、停用解析、数据根目录解析、临时 profile 上的来源与分组；**并对本机真实 profile 做只读断言** |
| `tests/pins.test.mjs` | 固定项存储：归一化/去重/上限、按 profile 分桶、坏 JSON 不炸、原子写不留 `.tmp`、写失败不破坏旧文件 |
| `tests/host-route.test.mjs` | 把 `lib/index.js` 挂到最小 cordis 上下文上，用真 `node:http` 打真请求：动作头 403、405/Allow、请求体 400、真实 profile 的分组结果、pins 读写与降级、应答不泄漏绝对路径、卸载时路由撤下 |
| `tests/client.test.mjs` | 用 `window.__ModuleLoader__` 桩加载**真实产物** `lib/client.js`：账本投影、索引/label 对齐、收纳与还原、点击代理、固定/取消的乐观更新与失败回退、**固定数为 0 时整块「固定」区域不渲染（含已保存状态行）而分组列表照常**、与宿主对话的成功/失败两条路径、`apply` 接线与 dispose 还原 |
| `tests/integration.test.mjs` | **两个半边真打**：浏览器的 fetch 直接打到宿主 handler 上（路径/动作头/字段名对不对），固定→落盘→**模拟重启换实例**后固定项仍在，取消到 0 后整块「固定」区域随之隐藏，临时显示全部分页不动固定项 |
| `tests/install-scripts.test.mjs` | 在临时 profile 上真跑安装/回滚脚本：dry-run 不落盘、幂等、整文件回滚、被别的改动岔开时只摘自己的痕迹 |
| `tests/submit-market.test.mjs` | 市场投稿脚本：条目文件定位（0/1/多个）、`<owner>__<repo>.yml` 文件名规则、分支名与 PR 正文生成，以及**默认 dry-run 不发网络请求** |

这台机器上 headless Chromium 起不来（root 无沙箱），所以浏览器侧用一个最小假 DOM
（`tests/fake-dom.mjs`）驱动，而不是跳过。

## 已知限制

- **只收纳左侧栏分页**。插件注册到「插件」分区标签页（`settings.plugins.tab`）或
  `settings.plugin.item` 的配置卡不在收纳范围内——它们本来就不占左侧栏。
- **固定项只影响本插件对左侧栏的收纳**。它不改别的插件、不改 DSH 设置文档；删掉
  `pins.json` 就等于「全部收纳」。
- **分页归属靠 bundle 文本提取**。若某插件的分页 id 是运行时动态拼出来的，它会被判成
  「来源未识别」（仍然被收纳、仍然可点开，仍然可以固定，只是不打来源标签）。
- **内置分页白名单**（`general / models / plugins / agent-presets / archived-sessions`）写死在
  `lib/inventory.js`。DSH 将来新增内置分页时，只要它的归属包不在 profile 依赖里，就仍会被
  判为内置留在原地；纯靠 id 白名单兜底的分支才需要同步更新。
- **左侧栏收纳是 DOM 层操作**：官方外壳换成非 `nav > button` 结构时，本插件会识别不出按钮
  并**放弃隐藏**（此时左侧栏就是原生形状，功能不受损，收纳页里的卡片依然可用）。

## 回滚

```sh
node scripts/rollback-profile.mjs   # 只摘本插件的痕迹；若安装后没被别的改动岔开则整文件还原备份
```

然后重启 dsh。回滚判断依据是 `package.json.dsh-settings-plugin-hub.bak`：若当前文件仍等于
「安装后状态」就整文件还原并消费备份；若安装之后又被别的插件/手工改过，就只反向摘掉本插件
写的那两处，备份保留供人工比对。

回滚**不删** `plugin-data/dsh-settings-plugin-hub/pins.json`：那是你的选择，重装后还在。
要一并清掉就手动删该文件（或整个目录）。

## 目录

| 文件 | 职责 |
|---|---|
| `lib/inventory.js` | 宿主侧纯逻辑：spec 归类、bundle 分页提取、profile 清单、分页→包的分组 |
| `lib/pins.js` | 固定项存储：读写 `plugin-data/…/pins.json`（原子写、按 profile 分桶） |
| `lib/index.js` | 宿主插件：三个 HTTP 端点 + 动作头校验 |
| `lib/client.js` | 浏览器半边：收纳分页注册、左侧栏观察器、点击代理、收纳页与手工选择区 |
| `cordis.patch.yml` | bundle patch：把宿主半边挂进 profile |
| `scripts/` | profile 改动的单一实现 + 安装/回滚脚本 + 市场投稿脚本 |
| `market/` | awesome-dsh-plugin（市场列表数据源）的收录条目，一个文件就是全部投稿 |

## 许可

MIT
