/**
 * dsh-settings-plugin-hub —— 「固定在左侧栏显示」白名单存储测试。
 *
 * 这份数据是用户唯一的显式选择，所以边界要钉死：坏文件不能让插件失效、
 * 原子写不能留残渣、按 profile 分桶不能串台、写不进去要如实报错。
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  PINS_CAP,
  PINS_VERSION,
  normalizePins,
  pinsFilePath,
  readPins,
  togglePin,
  writePins,
} from '../lib/pins.js';

const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-pins-'));
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

describe('normalizePins', () => {
  it('只留非空字符串、去空白、去重、保持顺序', () => {
    assert.deepEqual(normalizePins([' vision ', 'cool-theme', 'vision', '', '   ', 42, null, {}, 'x']), ['vision', 'cool-theme', 'x']);
  });

  it('非数组输入一律空', () => {
    for (const input of [undefined, null, 'vision', 42, {}]) assert.deepEqual(normalizePins(input), []);
  });

  it('按上限截断，且单条 id 有长度上限', () => {
    const many = Array.from({ length: PINS_CAP + 50 }, (_, index) => `sec-${index}`);
    assert.equal(normalizePins(many).length, PINS_CAP);
    assert.equal(normalizePins(['x'.repeat(500)])[0].length, 120);
  });
});

describe('togglePin', () => {
  it('加入 / 移出 / 幂等', () => {
    assert.deepEqual(togglePin([], 'vision'), ['vision']);
    assert.deepEqual(togglePin(['vision', 'x'], 'vision'), ['x']);
    assert.deepEqual(togglePin(['x'], 'vision'), ['x', 'vision']);
    assert.deepEqual(togglePin(['vision'], 'vision'), []);
  });

  it('空 id 与脏输入不改变集合', () => {
    assert.deepEqual(togglePin(['a'], ''), ['a']);
    assert.deepEqual(togglePin(['a'], undefined), ['a']);
    assert.deepEqual(togglePin(undefined, 'a'), ['a']);
  });
});

describe('pinsFilePath', () => {
  it('落在 plugin-data/<插件>/pins.json', () => {
    assert.equal(pinsFilePath('/data'), join('/data', 'plugin-data', 'dsh-settings-plugin-hub', 'pins.json'));
  });

  it('数据根目录拿不到时返回 null（调用方据此降级，而不是写到相对路径）', () => {
    assert.equal(pinsFilePath(''), null);
    assert.equal(pinsFilePath(undefined), null);
  });
});

describe('readPins', () => {
  it('文件不存在 = 空列表且不算错误（全新安装就是这样）', () => {
    const file = join(tempDir(), 'pins.json');
    assert.deepEqual(readPins(file, 'web'), { pins: [], updatedAt: 0, error: null });
  });

  it('路径未解析时返回空并报错', () => {
    const result = readPins(null, 'web');
    assert.deepEqual(result.pins, []);
    assert.match(result.error, /path unresolved/);
  });

  it('坏 JSON / 非对象 都不抛，只退化 + 报错', () => {
    const dir = tempDir();
    const file = join(dir, 'pins.json');
    writeFileSync(file, '{not json');
    const broken = readPins(file, 'web');
    assert.deepEqual(broken.pins, []);
    assert.match(broken.error, /cannot read pins file/);

    writeFileSync(file, JSON.stringify([1, 2, 3]));
    const arrayShape = readPins(file, 'web');
    assert.deepEqual(arrayShape.pins, []);
    assert.match(arrayShape.error, /not an object/);
  });

  it('版本不认识时仍照读固定项，并如实标注', () => {
    const dir = tempDir();
    const file = join(dir, 'pins.json');
    writeFileSync(file, JSON.stringify({ version: 99, profiles: { web: { pins: ['vision'], updatedAt: 5 } } }));
    const result = readPins(file, 'web');
    assert.deepEqual(result.pins, ['vision']);
    assert.equal(result.updatedAt, 5);
    assert.match(result.error, /unexpected pins file version/);
  });

  it('缺 profiles 字段时也算空', () => {
    const dir = tempDir();
    const file = join(dir, 'pins.json');
    writeFileSync(file, JSON.stringify({ version: PINS_VERSION }));
    assert.deepEqual(readPins(file, 'web').pins, []);
  });
});

describe('writePins + readPins', () => {
  it('往返一致，并自动建目录', () => {
    const file = pinsFilePath(tempDir());
    const written = writePins(file, 'web', ['vision', 'better-display']);
    assert.equal(written.ok, true, written.error);
    assert.deepEqual(written.pins, ['vision', 'better-display']);
    assert.ok(existsSync(file));
    assert.deepEqual(readPins(file, 'web').pins, ['vision', 'better-display']);
  });

  it('按 profile 分桶，写一个不影响另一个', () => {
    const file = pinsFilePath(tempDir());
    writePins(file, 'web', ['vision']);
    writePins(file, 'other', ['cost-meter']);
    assert.deepEqual(readPins(file, 'web').pins, ['vision']);
    assert.deepEqual(readPins(file, 'other').pins, ['cost-meter']);
    writePins(file, 'web', []);
    assert.deepEqual(readPins(file, 'web').pins, []);
    assert.deepEqual(readPins(file, 'other').pins, ['cost-meter'], '清空 web 不该动 other');
  });

  it('写入的文件是给人看懂的 JSON，且不留 .tmp', () => {
    const dir = tempDir();
    const file = pinsFilePath(dir);
    writePins(file, 'web', ['vision'], 1700000000000);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.version, PINS_VERSION);
    assert.deepEqual(raw.profiles.web, { pins: ['vision'], updatedAt: 1700000000000 });
    assert.equal(existsSync(`${file}.tmp`), false);
  });

  it('目标不可写时 ok:false + 报错，且不抛、不留 .tmp', () => {
    const dir = tempDir();
    // 用一个文件当目录：mkdir 必然 ENOTDIR。
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const file = join(blocker, 'plugin-data', 'pins.json');
    const result = writePins(file, 'web', ['vision']);
    assert.equal(result.ok, false);
    assert.match(result.error, /cannot write pins file/);
    assert.deepEqual(result.pins, ['vision'], '返回值仍如实带上用户意图，便于界面回显');
    assert.equal(existsSync(`${file}.tmp`), false);

    // 只读目录（chmod 500）也要如实失败 —— 只在非 root 下有意义。
    if (process.getuid?.() !== 0) {
      const locked = join(dir, 'locked');
      mkdirSync(locked);
      writeFileSync(join(locked, 'keep'), 'x');
      chmodSync(locked, 0o500);
      const denied = writePins(join(locked, 'pins.json'), 'web', ['vision']);
      assert.equal(denied.ok, false);
    }
  });

  it('写失败不破坏已有文件内容', () => {
    const dir = tempDir();
    const file = pinsFilePath(dir);
    writePins(file, 'web', ['vision']);
    const before = readFileSync(file, 'utf8');
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const result = writePins(join(blocker, 'sub', 'pins.json'), 'web', ['cost-meter']);
    assert.equal(result.ok, false);
    assert.equal(readFileSync(file, 'utf8'), before);
  });
});
