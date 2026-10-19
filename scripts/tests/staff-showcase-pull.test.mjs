import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, access, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeShowcaseSnapshot, downloadShowcase } from "../pull-staff-showcase.mjs";

const staffId = "11111111-1111-4111-8111-111111111111";
const content = Buffer.from("selected media");
const sha256 = createHash("sha256").update(content).digest("hex");
const item = (slot) => ({ type: "image", extension: ".png", sizeBytes: content.length, sha256, url: `/api/public/staff-showcase/${staffId}/${slot}/${sha256}` });
const snapshot = (items) => ({ schemaVersion: 1, coverage: "configured", snapshotVersion: "a".repeat(64), profiles: [{ staffId, profileRevision: 3, items }] });

test("四项保留顺序，未配置与明确清空可以区分", () => {
  assert.equal(normalizeShowcaseSnapshot(snapshot([item(0), item(1), item(2), item(3)]))[0].items.length, 4);
  assert.deepEqual(normalizeShowcaseSnapshot({ ...snapshot([]), profiles: [] }), []);
  assert.deepEqual(normalizeShowcaseSnapshot(snapshot([]))[0].items, []);
});

test("拒绝第五项、错误类型、跨源下载、路径逃逸与重复人员", () => {
  assert.throws(() => normalizeShowcaseSnapshot(snapshot(Array.from({ length: 5 }, (_, i) => item(i)))));
  for (const wrong of [{ ...item(0), url: "https://elsewhere.test/file" }, { ...item(0), extension: ".html" }, { ...item(0), url: "../../secret" }, { ...item(0), sizeBytes: 0 }, { ...item(0), sha256: [sha256] }]) {
    assert.throws(() => normalizeShowcaseSnapshot(snapshot([wrong])));
  }
  assert.throws(() => normalizeShowcaseSnapshot({ ...snapshot([]), profiles: [snapshot([]).profiles[0], snapshot([]).profiles[0]] }));
});

test("下载到新暂存目录并逐项核验；失败不覆盖旧文件", async () => {
  const base = await mkdtemp(join(tmpdir(), "staff-showcase-test-"));
  let payload = content;
  const server = createServer((request, response) => { response.end(payload); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const source = `http://127.0.0.1:${server.address().port}/api/public/staff-showcase`;
  const profile = normalizeShowcaseSnapshot(snapshot([item(0), item(1)]))[0];
  try {
    const output = await downloadShowcase(profile, source, join(base, "downloaded"));
    assert.deepEqual(await readFile(join(output, "01.png")), content);
    assert.deepEqual(await readFile(join(output, "02.png")), content);
    await assert.rejects(() => downloadShowcase(profile, source, output));
    assert.deepEqual(await readFile(join(output, "01.png")), content);
    payload = Buffer.from("wrong content");
    await assert.rejects(() => downloadShowcase(profile, source, join(base, "failed")));
    await assert.rejects(() => access(join(base, "failed")));
    await assert.rejects(() => downloadShowcase({ ...profile, items: [] }, source, join(base, "clear")));
    await assert.rejects(() => access(join(base, "clear")));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  }
});


test("仓库内点点目录和指向仓库的父链接都不能存原件", async () => {
  const base = await mkdtemp(join(tmpdir(), "staff-showcase-boundary-"));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const profile = normalizeShowcaseSnapshot(snapshot([item(0)]))[0];
  const internal = join(root, "..showcase-test-originals");
  const link = join(base, "site-link");
  try {
    await assert.rejects(() => downloadShowcase(profile, "http://127.0.0.1:1/", internal), /仓库外/);
    await symlink(root, link, "dir");
    await assert.rejects(() => downloadShowcase(profile, "http://127.0.0.1:1/", join(link, "showcase-test-originals")), /仓库外/);
    await assert.rejects(() => access(internal));
    await assert.rejects(() => access(join(root, "showcase-test-originals")));
  } finally { await rm(base, { recursive: true, force: true }); }
});
