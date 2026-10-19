/** 按 staffId 拉取已选原件；不修改站点正文、mediaFolder 或既有成品。 */
import { createHash } from "node:crypto";
import { readFile, mkdir, open, rm, realpath } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VIDEO = new Set([".mov", ".mp4"]);
const MAX_SOURCE_BYTES = 500 * 1024 * 1024;

export function normalizeShowcaseSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || value.coverage !== "configured" || !Array.isArray(value.profiles) || !HASH.test(value.snapshotVersion)) {
    throw new Error("展示素材清单格式无效");
  }
  const seen = new Set();
  return value.profiles.map((profile) => {
    if (typeof profile.staffId !== "string" || !UUID.test(profile.staffId) || seen.has(profile.staffId) || !Number.isSafeInteger(profile.profileRevision) || profile.profileRevision < 0 || !Array.isArray(profile.items) || profile.items.length > 4) {
      throw new Error("人员 ID、版本或展示数量无效");
    }
    seen.add(profile.staffId);
    const items = profile.items.map((item, slot) => {
      const validType = item.type === "image" ? IMAGE.has(item.extension) : item.type === "video" && VIDEO.has(item.extension);
      if (!validType || typeof item.sha256 !== "string" || !HASH.test(item.sha256) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1 || item.sizeBytes > MAX_SOURCE_BYTES || item.url !== `/api/public/staff-showcase/${profile.staffId}/${slot}/${item.sha256}`) {
        throw new Error("展示素材类型、摘要或下载地址无效");
      }
      return { type: item.type, extension: item.extension, sizeBytes: item.sizeBytes, sha256: item.sha256, url: item.url };
    });
    return { staffId: profile.staffId, profileRevision: profile.profileRevision, items };
  });
}

async function responseFor(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`展示素材请求失败：HTTP ${response.status}`);
  if (!response.body) throw new Error("服务器未返回内容");
  return response;
}

async function readManifest(url) {
  const response = await responseFor(url);
  const chunks = [];
  let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    if (count > 5 * 1024 * 1024) throw new Error("展示清单超过 5 MiB");
    chunks.push(chunk);
  }
  return normalizeShowcaseSnapshot(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export async function downloadShowcase(profile, source, destination) {
  if (!profile.items.length) throw new Error("该人员已明确清空展示，不下载或删除既有站点素材");
  const requested = resolve(destination);
  const target = resolve(await realpath(dirname(requested)), basename(requested));
  const within = relative(PROJECT_ROOT, target);
  if (!within || !(within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))) throw new Error("原件下载目录必须位于站点仓库外");
  await mkdir(target); // 新目录保证旧文件不会被覆盖。
  try {
    for (const [index, item] of profile.items.entries()) {
      const url = new URL(item.url, source);
      if (url.origin !== new URL(source).origin) throw new Error("素材不能跨源下载");
      const response = await responseFor(url);
      const file = await open(resolve(target, `${String(index + 1).padStart(2, "0")}${item.extension}`), "wx");
      const hash = createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > item.sizeBytes) throw new Error("素材大小超出清单，停止同步");
          hash.update(chunk);
          await file.writeFile(chunk);
        }
      } finally { await file.close(); }
      if (size !== item.sizeBytes || hash.digest("hex") !== item.sha256) throw new Error("素材内容与选中版本不同，停止同步");
    }
    return target;
  } catch (error) {
    await rm(target, { recursive: true, force: true }); // 只回收本次新建的暂存目录。
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: "string" }, "staff-id": { type: "string" }, "download-to": { type: "string" },
    check: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    process.stdout.write("用法：node scripts/pull-staff-showcase.mjs --source URL [--staff-id UUID] [--download-to 仓库外新目录] [--check] [--json]\n默认只读清单。下载后沿用 import-staff-media.mjs 生成站内成品；不会修改 data.json 或发布网站。\n");
    return;
  }
  if (!values.source) throw new Error("必须提供 --source 展示清单地址");
  if (values.check && values["download-to"]) throw new Error("--check 不能同时下载文件");
  const source = new URL(values.source);
  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) throw new Error("清单地址必须是无内嵌凭据的 HTTP(S) URL");
  const cloud = await readManifest(source);
  const data = JSON.parse(await readFile(resolve(PROJECT_ROOT, "assets/data/data.json"), "utf8"));
  const staff = new Map(data.staff.map((item) => [item.staffId, item]));
  const selected = values["staff-id"] ? cloud.filter((item) => item.staffId === values["staff-id"]) : cloud;
  if (values["staff-id"] && !selected.length) throw new Error("该人员尚未配置展示素材，保留站点原有素材");
  const result = { profiles: selected.map((item) => ({ staffId: item.staffId, profileRevision: item.profileRevision, count: item.items.length, mediaFolder: staff.get(item.staffId)?.mediaFolder ?? null, action: item.items.length ? "可拉取" : "明确清空，需单独处理站点关联" })) };
  if (values["download-to"]) {
    if (!values["staff-id"] || selected.length !== 1 || !staff.has(selected[0].staffId)) throw new Error("下载需要明确选择站点已有的 staffId");
    const output = await downloadShowcase(selected[0], source, values["download-to"]);
    result.sourceDirectory = output;
    const folder = staff.get(selected[0].staffId).mediaFolder;
    result.importArgs = folder ? ["node", "scripts/import-staff-media.mjs", "--source", output, "--folder", folder, "--replace"] : null;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => { process.stderr.write(`拉取展示素材失败：${error.message}\n`); process.exitCode = 1; });
}
