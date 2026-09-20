/**
 * dsh-settings-plugin-hub —— 宿主半边。
 *
 * 浏览器半边需要两件只有宿主才拿得到的事实：
 *
 *   1. 「每个第三方设置分页背后的插件是本机目录装的还是远程装的」——要解析 profile
 *      的 package.json、跟踪 node_modules 里 link: 依赖的软链、并把 `settings.section`
 *      id 归属到具体包；
 *   2. 「用户手工固定在左侧栏显示的分页」——一份跨重启、跨浏览器生效的白名单。
 *
 * 因此注册三个端点：
 *
 *   GET  /settings-plugin-hub/inventory   当前 profile 的包清单（来源 + 分页归属）
 *   POST /settings-plugin-hub/resolve     浏览器上报的左侧栏分页 → 分组结果 + 固定项
 *   GET  /settings-plugin-hub/pins        读「固定在左侧栏显示」白名单
 *   PUT  /settings-plugin-hub/pins        写白名单（唯一的写操作，落盘 plugin-data/）
 *
 * 安全取舍：
 *   - webServer 路由不带浏览器会话鉴权（宿主只给页面壳加鉴权），所以三个端点都要求
 *     自定义动作头 x-settings-plugin-hub-action；跨站表单/图片标签无法携带自定义头，
 *     也因此挡住了顺手被第三方面板探测的路子。
 *   - 返回值不含任何绝对路径（见 inventory.js 的 displaySpec）。
 */
import {
  HUB_SECTION_ID,
  classifySections,
  collectedSectionIds,
  readProfileInventory,
  resolveDshHome,
  resolveProfileDir,
} from './inventory.js';
import { normalizePins, pinsFilePath, readPins, writePins } from './pins.js';

export const name = 'settings-plugin-hub';

/** 动作头：与 dsh-vision-assistant 的 x-vision-config-action 同款约定。 */
const ACTION_HEADER = 'x-settings-plugin-hub-action';
/** 请求体上限：浏览器只上报左侧栏分页清单，正常不超过几 KB。 */
const BODY_CAP = 256 * 1024;
/** 单次上报的分页条数上限。 */
const SECTION_CAP = 200;

/** 统一 JSON 应答（一律禁缓存：这是一份即时快照）。 */
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 校验动作头。缺失/不匹配时直接答复 403 并返回 false。 */
function requireAction(req, res, action) {
  const value = req.headers?.[ACTION_HEADER];
  if (typeof value === 'string' && value === action) return true;
  json(res, 403, { ok: false, error: `missing or invalid ${ACTION_HEADER} header` });
  return false;
}

/** 读取并解析请求体（带上限与形状校验）。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_CAP) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  return JSON.parse(text);
}

/** 把上报的分页条目收敛成受控形状（长度上限 + 类型收敛）。 */
function normalizeSections(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input.slice(0, SECTION_CAP)) {
    if (raw === null || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id.slice(0, 120) : '';
    if (id === '') continue;
    out.push({
      id,
      label: typeof raw.label === 'string' ? raw.label.slice(0, 120) : id,
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
      registrant: typeof raw.registrant === 'string' ? raw.registrant.slice(0, 200) : '',
    });
  }
  return out;
}

/** 对外暴露的包清单：只保留判断来源所需字段。 */
function publicPackages(packages) {
  return packages.map((pkg) => ({
    name: pkg.name,
    spec: pkg.spec,
    source: pkg.source,
    kind: pkg.kind,
    bundle: pkg.bundle,
    disabled: pkg.disabled,
    hasClient: pkg.hasClient,
    sectionIds: pkg.sectionIds,
    bundleId: pkg.bundleId,
  }));
}

/**
 * 宿主插件入口。
 * @param {object} ctx - cordis 上下文。
 * @param {{config?: {profile?: string, profileDir?: string, dataDir?: string}}} [entry] - Loader 条目（含 patch 里的 config）。
 */
export function apply(ctx, entry) {
  const config = entry?.config ?? {};
  const profile = typeof config.profile === 'string' && config.profile.trim() !== '' ? config.profile.trim() : 'web';

  /** 解析 profile 目录：显式 config 优先，其次 $DSH_HOME / ~/.dsh。 */
  const profileDirOf = () => resolveProfileDir({
    profile,
    ...(typeof config.profileDir === 'string' ? { profileDir: config.profileDir } : {}),
  });

  /** 「固定在左侧栏显示」白名单的落盘位置（$DSH_HOME/plugin-data/<插件>/pins.json）。 */
  const pinsFileOf = () => pinsFilePath(resolveDshHome(
    typeof config.dataDir === 'string' && config.dataDir.trim() !== '' ? { dshHome: config.dataDir } : {},
  ) ?? '');

  /** 读一次清单（每次调用都是即时快照，不做缓存）。 */
  const inventoryOf = () => readProfileInventory(profileDirOf());

  const pinsOf = () => readPins(pinsFileOf(), profile);

  ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: '/settings-plugin-hub/inventory',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' });
          res.end();
          return;
        }
        if (!requireAction(req, res, 'inventory')) return;
        const inventory = inventoryOf();
        json(res, 200, {
          ok: inventory.ok,
          error: inventory.error,
          profile,
          generatedAt: Date.now(),
          bundles: inventory.bundles,
          disabled: inventory.disabled,
          packages: publicPackages(inventory.packages),
        });
      },
    }), 'settings-plugin-hub: inventory route');

    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: '/settings-plugin-hub/resolve',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        if (!requireAction(req, res, 'resolve')) return;
        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          json(res, 400, { ok: false, error: `invalid request body: ${error?.message ?? String(error)}` });
          return;
        }
        const sections = normalizeSections(body?.sections);
        // 固定项随分组一起下发：浏览器半边据此做「收纳结果 − 固定项」，并在固定/取消时
        // 先本地生效再落盘，避免等一次往返才更新左侧栏。
        const pinsState = pinsOf();
        const inventory = inventoryOf();
        if (!inventory.ok) {
          json(res, 200, {
            ok: false,
            error: inventory.error,
            profile,
            generatedAt: Date.now(),
            builtin: [HUB_SECTION_ID],
            hiddenIds: [],
            groups: { local: [], remote: [], unknown: [] },
            pins: pinsState.pins,
            pinsUpdatedAt: pinsState.updatedAt,
            pinsError: pinsState.error,
          });
          return;
        }
        const classification = classifySections(sections, inventory);
        json(res, 200, {
          ok: true,
          profile,
          generatedAt: Date.now(),
          builtin: classification.builtin,
          hiddenIds: collectedSectionIds(classification),
          groups: classification.groups,
          pins: pinsState.pins,
          pinsUpdatedAt: pinsState.updatedAt,
          pinsError: pinsState.error,
        });
      },
    }), 'settings-plugin-hub: resolve route');

    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: '/settings-plugin-hub/pins',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'PUT') {
          res.writeHead(405, { allow: 'GET, PUT' });
          res.end();
          return;
        }
        if (!requireAction(req, res, 'pins')) return;
        if (req.method === 'GET') {
          const state = pinsOf();
          json(res, 200, {
            ok: state.error === null,
            error: state.error,
            profile,
            pins: state.pins,
            updatedAt: state.updatedAt,
            file: pinsFileOf() === null ? null : 'plugin-data/dsh-settings-plugin-hub/pins.json',
          });
          return;
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          json(res, 400, { ok: false, error: `invalid request body: ${error?.message ?? String(error)}` });
          return;
        }
        if (body === null || typeof body !== 'object' || !Array.isArray(body.pins)) {
          json(res, 400, { ok: false, error: 'body must be {"pins": string[]}' });
          return;
        }
        const requested = normalizePins(body.pins);
        // 被忽略的条目数（非字符串 / 空串 / 重复 / 超上限），只作提示用。
        const dropped = body.pins.length - requested.length;
        const written = writePins(pinsFileOf(), profile, requested);
        json(res, written.ok ? 200 : 500, {
          ok: written.ok,
          error: written.error,
          profile,
          pins: written.pins,
          updatedAt: written.updatedAt,
          dropped,
        });
      },
    }), 'settings-plugin-hub: pins route');

    ctx.logger?.info?.(`settings-plugin-hub: 已挂载 /settings-plugin-hub（profile=${profile}, dir=${profileDirOf() ?? 'unresolved'}）`);
  });
}
