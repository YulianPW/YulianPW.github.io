import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSha256 } from "../staff-details-contract.mjs";
import { findLocalMedia, syncStaff } from "../sync-staff.mjs";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const remoteId = "33333333-3333-4333-8333-333333333333";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const firstBytes = Buffer.from("first selected file");
const secondBytes = Buffer.from("other selected file");
const mediaItem = (bytes, slot, staffId = firstId) => ({
  type: "image", extension: ".jpg", sizeBytes: bytes.length, sha256: hash(bytes),
  url: `/api/public/staff-showcase/${staffId}/${slot}/${hash(bytes)}`,
});

function commit(root) {
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "staff-sync-test-")));
  const root = join(base, "site");
  const originals = join(base, "originals");
  const dataPath = join(root, "assets/data/data.json");
  const mediaRoot = join(root, "assets/media/staff");
  const receiptPath = join(root, ".staff-showcase-sync.local.json");
  await mkdir(dirname(dataPath), { recursive: true });
  await mkdir(join(mediaRoot, "first"), { recursive: true });
  await mkdir(join(mediaRoot, "second"), { recursive: true });
  await mkdir(originals);
  await writeFile(join(originals, "renamed-first.JPG"), firstBytes);
  await writeFile(join(originals, "renamed-other.jpg"), secondBytes);
  await writeFile(join(originals, "00-wrong.jpg"), Buffer.alloc(firstBytes.length, "x"));
  const data = { staff: [
    { staffId: firstId, name: "第一位", tags: "绿色陪", social: "", detailsRevision: 1,
      details: { intro: "old" }, mediaFolder: "first" },
    { staffId: secondId, name: "第二位", tags: "绿色陪", social: "", detailsRevision: 1,
      details: { intro: "unchanged" }, mediaFolder: "second" },
  ] };
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  await writeFile(join(mediaRoot, "first", "media.json"), "old first media");
  await writeFile(join(mediaRoot, "second", "media.json"), "old second media");
  await writeFile(join(root, ".gitignore"),
    ".staff-sync-*\n.staff-sync.local.json\n.staff-showcase-sync.local.json\n");
  execFileSync("git", ["-C", root, "init", "--quiet"]);
  commit(root);

  const profiles = [
    { staffId: firstId, revision: 2, updatedAt: "2026-11-07T00:00:00Z", details: { intro: "latest" } },
    { staffId: secondId, revision: 1, updatedAt: "2026-11-07T00:00:00Z", details: { intro: "unchanged" } },
    { staffId: remoteId, revision: 1, updatedAt: "2026-11-07T00:00:00Z", details: { intro: "remote only" } },
  ];
  const details = {
    schemaVersion: 1, coverage: "full", profiles,
    snapshotVersion: canonicalSha256({ schemaVersion: 1, coverage: "full", profiles }),
    generatedAt: "2026-11-07T00:00:00Z",
  };
  const showcase = {
    schemaVersion: 1, coverage: "configured", snapshotVersion: "a".repeat(64),
    profiles: [{ staffId: firstId, profileRevision: 2,
      items: [mediaItem(secondBytes, 0), mediaItem(firstBytes, 1)] }],
  };
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/public/staff-details") response.end(JSON.stringify(details));
    else if (request.url === "/api/public/staff-showcase") response.end(JSON.stringify(showcase));
    else { response.statusCode = 500; response.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  const rendered = [];
  const options = {
    source: `http://127.0.0.1:${server.address().port}`,
    projectRoot: root, mediaRoots: [originals], mode: "check",
    // 隔离本机转码边界；实际转码另用真实素材验收。
    buildMedia: async (media, output) => {
      const items = [];
      for (const [index, item] of media.entries()) {
        const bytes = await readFile(item.path);
        items.push(bytes.toString());
        await writeFile(join(output, `${index + 1}.webp`), bytes);
      }
      rendered.push(items);
      await writeFile(join(output, "media.json"), JSON.stringify({ items }));
    },
    validateLibrary: async () => {},
  };
  return { root, originals, dataPath, mediaRoot, receiptPath, data, details, showcase,
    requests, options, rendered };
}

test("预演同时报告价格与素材变化，按内容匹配改名原件并保留云端顺序", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.dataPath, "utf8");
  const result = await syncStaff(f.options);
  assert.equal(result.result, "changes");
  assert.deepEqual(result.changedStaffIds, [firstId]);
  assert.deepEqual(result.remoteOnlyStaffIds, [remoteId]);
  assert.deepEqual(result.mediaChanges[0].localFiles, [
    join(f.originals, "renamed-other.jpg"), join(f.originals, "renamed-first.JPG"),
  ]);
  assert.equal(await readFile(f.dataPath, "utf8"), before);
  assert.equal(await readFile(join(f.mediaRoot, "second", "media.json"), "utf8"), "old second media");
  assert.deepEqual(f.rendered, []);
  assert.deepEqual(f.requests.sort(), ["/api/public/staff-details", "/api/public/staff-showcase"]);
});

test("缺本地素材时整次阻断，价格、现有素材与原件均保留", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.dataPath, "utf8");
  await rm(join(f.originals, "renamed-other.jpg"));
  const result = await syncStaff({ ...f.options, mode: "apply" });
  assert.equal(result.result, "blocked");
  assert.equal(result.missingLocalFiles.length, 1);
  assert.equal(result.missingLocalFiles[0].slot, 1);
  assert.equal(await readFile(f.dataPath, "utf8"), before);
  assert.equal(await readFile(join(f.mediaRoot, "first", "media.json"), "utf8"), "old first media");
  await assert.rejects(readFile(f.receiptPath), { code: "ENOENT" });
  assert.deepEqual(f.rendered, []);
});

test("同次应用价格与展示，复跑幂等，价格版本变化不会单独重转码", async (t) => {
  const f = await fixture(t);
  const result = await syncStaff({ ...f.options, mode: "apply" });
  assert.equal(result.result, "applied");
  const data = JSON.parse(await readFile(f.dataPath, "utf8"));
  assert.equal(data.staff[0].details.intro, "latest");
  assert.equal(data.staff[0].detailsRevision, 2);
  assert.equal(data.staff[0].mediaFolder, "first");
  assert.equal(data.staff.length, 2);
  assert.deepEqual(data.staff[1], f.data.staff[1]);
  assert.deepEqual(f.rendered, [[secondBytes.toString(), firstBytes.toString()]]);
  assert.deepEqual(JSON.parse(await readFile(join(f.mediaRoot, "first", "media.json"))).items,
    [secondBytes.toString(), firstBytes.toString()]);
  assert.deepEqual(await readFile(join(f.originals, "renamed-first.JPG")), firstBytes);
  await assert.rejects(stat(join(f.root, "assets/data/staff-showcase-sync.json")), { code: "ENOENT" });
  assert.equal(execFileSync("git", ["-C", f.root, "check-ignore", "--",
    ".staff-showcase-sync.local.json"], { encoding: "utf8" }).trim(),
    ".staff-showcase-sync.local.json");
  f.showcase.profiles[0].profileRevision += 1;
  const again = await syncStaff({ ...f.options, mode: "apply" });
  assert.equal(again.result, "no-op");
  assert.equal(f.rendered.length, 1);
  commit(f.root);
  assert.equal(execFileSync("git", ["-C", f.root, "ls-files", "--",
    ".staff-showcase-sync.local.json"], { encoding: "utf8" }), "");
  f.details.profiles[0].revision = 3;
  f.details.profiles[0].details = { intro: "latest again" };
  f.details.snapshotVersion = canonicalSha256({
    schemaVersion: 1, coverage: "full", profiles: f.details.profiles,
  });
  const priceOnly = await syncStaff({ ...f.options, mode: "apply" });
  assert.equal(priceOnly.result, "applied");
  assert.deepEqual(priceOnly.changedStaffIds, [firstId]);
  assert.deepEqual(priceOnly.mediaChanges, []);
  assert.equal(f.rendered.length, 1);
  assert.equal(JSON.parse(await readFile(f.dataPath)).staff[0].details.intro, "latest again");
  assert.deepEqual((await readdir(f.root)).filter((name) => name.startsWith(".staff-sync-")), []);
});

test("显式清空解除展示关联并保留原件，重新选择沿用原有稳定目录", async (t) => {
  const f = await fixture(t);
  const oldItems = f.showcase.profiles[0].items;
  f.showcase.profiles[0].items = [];
  assert.equal((await syncStaff({ ...f.options, mode: "apply" })).result, "applied");
  assert.equal(JSON.parse(await readFile(f.dataPath)).staff[0].mediaFolder, undefined);
  await assert.rejects(stat(join(f.mediaRoot, "first")), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(f.originals, "renamed-first.JPG")), firstBytes);
  assert.equal((await syncStaff({ ...f.options, mode: "apply" })).result, "no-op");
  commit(f.root);
  f.showcase.profiles[0].items = oldItems;
  await syncStaff({ ...f.options, mode: "apply" });
  assert.equal(JSON.parse(await readFile(f.dataPath)).staff[0].mediaFolder, "first");
});

test("清单缺席保持旧展示，云端独有人员不自动建档", async (t) => {
  const f = await fixture(t);
  f.showcase.profiles = [{ staffId: remoteId, profileRevision: 1, items: [] }];
  const result = await syncStaff({ ...f.options, mode: "apply" });
  assert.deepEqual(result.mediaChanges, []);
  assert.deepEqual(result.remoteOnlyShowcaseStaffIds, [remoteId]);
  assert.equal(JSON.parse(await readFile(f.dataPath)).staff[0].mediaFolder, "first");
  assert.equal(await readFile(join(f.mediaRoot, "first", "media.json"), "utf8"), "old first media");
});

test("已有人员首次配置素材，按 staffId 生成并显式写入稳定目录关联", async (t) => {
  const f = await fixture(t);
  delete f.data.staff[0].mediaFolder;
  await writeFile(f.dataPath, `${JSON.stringify(f.data, null, 2)}\n`);
  await rm(join(f.mediaRoot, "first"), { recursive: true });
  commit(f.root);
  await syncStaff({ ...f.options, mode: "apply" });
  const data = JSON.parse(await readFile(f.dataPath));
  assert.equal(data.staff[0].mediaFolder, `staff-${firstId}`);
  assert.ok((await stat(join(f.mediaRoot, `staff-${firstId}`, "media.json"))).isFile());
});

test("拒绝覆盖受影响的未提交文件，允许其他无关文件已有变更", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.dataPath, "utf8");
  await writeFile(join(f.mediaRoot, "first", "media.json"), "manual edit");
  await assert.rejects(syncStaff({ ...f.options, mode: "apply" }), /有未提交变更/);
  assert.equal(await readFile(f.dataPath, "utf8"), before);
  assert.equal(await readFile(join(f.mediaRoot, "first", "media.json"), "utf8"), "manual edit");
  await writeFile(join(f.mediaRoot, "first", "media.json"), "old first media");
  await writeFile(join(f.root, "unrelated.txt"), "keep me");
  assert.equal((await syncStaff({ ...f.options, mode: "apply" })).result, "applied");
  assert.equal(await readFile(join(f.root, "unrelated.txt"), "utf8"), "keep me");
});

test("转码或整库校验失败均不应用价格，清理本次暂存目录", async (t) => {
  for (const boundary of ["buildMedia", "validateLibrary"]) {
    const f = await fixture(t);
    const before = await readFile(f.dataPath, "utf8");
    await assert.rejects(syncStaff({ ...f.options, mode: "apply",
      [boundary]: async () => { throw new Error("failed boundary"); },
    }), /failed boundary/);
    assert.equal(await readFile(f.dataPath, "utf8"), before);
    assert.equal(await readFile(join(f.mediaRoot, "first", "media.json"), "utf8"), "old first media");
    await assert.rejects(readFile(f.receiptPath), { code: "ENOENT" });
    assert.deepEqual((await readdir(f.root)).filter((name) => name.startsWith(".staff-sync-")), []);
  }
});

test("转码时原件内容变化阻断应用", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.dataPath, "utf8");
  await assert.rejects(syncStaff({ ...f.options, mode: "apply", buildMedia: async (...args) => {
    await f.options.buildMedia(...args);
    await writeFile(join(f.originals, "renamed-first.JPG"), Buffer.alloc(firstBytes.length, "x"));
  } }), /本地原件已变化/);
  assert.equal(await readFile(f.dataPath, "utf8"), before);
});

test("缺少明确配置的根目录时报错，不能按同名或同体积素材猜测替代", async (t) => {
  const f = await fixture(t);
  await assert.rejects(findLocalMedia([mediaItem(firstBytes, 0)], [join(f.originals, "missing")]),
    { code: "ENOENT" });
  await rm(join(f.originals, "renamed-first.JPG"));
  assert.deepEqual(await findLocalMedia([mediaItem(firstBytes, 0)], [f.originals]), [null]);
});

test("CLI 默认按本机配置预演，stdout 为可解析 JSON，未请求媒体原件", async (t) => {
  const f = await fixture(t);
  const sourceScripts = dirname(dirname(fileURLToPath(import.meta.url)));
  await cp(sourceScripts, join(f.root, "scripts"), { recursive: true });
  await writeFile(join(f.root, ".staff-sync.local.json"), JSON.stringify({
    source: f.options.source, mediaRoots: ["../originals"],
  }));
  const { stdout } = await promisify(execFile)(process.execPath,
    [join(f.root, "scripts/sync-staff.mjs"), "--json"], { cwd: tmpdir() });
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "check");
  assert.equal(result.result, "changes");
  assert.equal(result.mediaChanges[0].count, 2);
  assert.deepEqual(f.requests.sort(), ["/api/public/staff-details", "/api/public/staff-showcase"]);
});
