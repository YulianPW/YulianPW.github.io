#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile,
} from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { fetchSnapshot, requireCleanTarget } from "./sync-staff-details.mjs";
import { mergeStaffDetails, normalizeStaffDetailsSnapshot } from "./staff-details-sync-core.mjs";
import { requireStaffId } from "./staff-details-contract.mjs";
import { normalizeShowcaseSnapshot } from "./pull-staff-showcase.mjs";
import { buildMediaFolder, checkAllMediaFolders } from "./import-staff-media.mjs";
import { validateStaffData } from "./validate-staff-data.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FOLDER = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const selectionDigest = (items) => digest(JSON.stringify(items.map(
  ({ type, extension, sizeBytes, sha256 }) => ({ type, extension, sizeBytes, sha256 }),
)));

async function optionalText(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function folderDigest(path) {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const files = entries.filter((item) => !item.name.startsWith(".")).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const hashes = [];
  for (const entry of files) {
    if (!entry.isFile()) throw new Error(`网站成品目录含非普通文件：${join(path, entry.name)}`);
    hashes.push([entry.name, await fileDigest(join(path, entry.name))]);
  }
  return digest(JSON.stringify(hashes));
}

function readReceipts(text) {
  if (text === null) return new Map();
  const value = JSON.parse(text);
  if (value?.schemaVersion !== 1 || !Array.isArray(value.profiles)) {
    throw new Error(".staff-showcase-sync.local.json 同步记录格式无效");
  }
  const result = new Map();
  for (const item of value.profiles) {
    requireStaffId(item?.staffId, "同步记录 staffId");
    if (result.has(item.staffId) || typeof item.mediaFolder !== "string" ||
        !FOLDER.test(item.mediaFolder) || typeof item.selectionSha256 !== "string" ||
        !HASH.test(item.selectionSha256) || !(item.outputSha256 === null ||
          (typeof item.outputSha256 === "string" && HASH.test(item.outputSha256)))) {
      throw new Error("展示素材同步记录的目录、摘要或人员 ID 无效");
    }
    result.set(item.staffId, item);
  }
  return result;
}

/** 仅按扩展名、大小和内容摘要匹配已有原件，不猜人员身份、不请求媒体下载路由。 */
export async function findLocalMedia(items, roots) {
  const wanted = new Map(items.map((item) => [
    `${item.sizeBytes}:${item.extension}:${item.sha256}`, item,
  ]));
  const sizes = new Set(items.map((item) => `${item.sizeBytes}:${item.extension}`));
  const extensions = new Set(items.map((item) => item.extension));
  const found = new Map();
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (found.size === wanted.size) return;
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(path); continue; }
      const extension = extname(entry.name).toLowerCase();
      if (!entry.isFile() || !extensions.has(extension)) continue;
      let metadata;
      try { metadata = await stat(path); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!sizes.has(`${metadata.size}:${extension}`)) continue;
      const key = `${metadata.size}:${extension}:${await fileDigest(path)}`;
      if (wanted.has(key) && !found.has(key)) found.set(key, path);
    }
  }
  if (wanted.size) {
    for (const root of new Set(roots)) {
      const actual = await realpath(root);
      if (!(await stat(actual)).isDirectory()) throw new Error(`本地素材根目录无效：${root}`);
      await visit(actual);
      if (found.size === wanted.size) break;
    }
  }
  return items.map((item) => found.get(`${item.sizeBytes}:${item.extension}:${item.sha256}`) ?? null);
}

/** 一次预演或应用：先准备全部成品，再一起替换价格、素材关联和同步记录。 */
export async function syncStaff({
  source, mediaRoots, mode = "check", projectRoot = PROJECT_ROOT,
  buildMedia = buildMediaFolder, validateLibrary = checkAllMediaFolders,
}) {
  const origin = new URL(source);
  if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password ||
      origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("source 必须是无凭据、无路径和查询参数的云节点地址");
  }
  const dataPath = join(projectRoot, "assets/data/data.json");
  const receiptsPath = join(projectRoot, ".staff-showcase-sync.local.json");
  const mediaRoot = join(projectRoot, "assets/media/staff");
  const [originalText, originalReceipts, detailsResponse, showcaseResponse] = await Promise.all([
    readFile(dataPath, "utf8"), optionalText(receiptsPath),
    fetchSnapshot(new URL("/api/public/staff-details", origin)),
    fetchSnapshot(new URL("/api/public/staff-showcase", origin)),
  ]);
  const originalData = JSON.parse(originalText);
  validateStaffData(originalData);
  const details = normalizeStaffDetailsSnapshot(detailsResponse.body);
  const showcase = normalizeShowcaseSnapshot(showcaseResponse.body);
  const merged = mergeStaffDetails(originalData, details);
  const receipts = readReceipts(originalReceipts);
  const staff = new Map(merged.data.staff.map((item) => [item.staffId, item]));
  const changes = [];
  for (const profile of showcase) {
    const person = staff.get(profile.staffId);
    if (!person) continue;
    const previous = receipts.get(profile.staffId);
    const folder = person.mediaFolder ?? previous?.mediaFolder ?? `staff-${profile.staffId}`;
    const selected = selectionDigest(profile.items);
    const cleared = profile.items.length === 0;
    const currentHash = person.mediaFolder ? await folderDigest(join(mediaRoot, folder)) : null;
    if (previous?.selectionSha256 === selected && previous.mediaFolder === folder &&
        previous.outputSha256 === currentHash && (cleared ? !person.mediaFolder : currentHash !== null)) {
      continue;
    }
    changes.push({ ...profile, name: person.name, folder, selected, cleared });
    if (cleared) delete person.mediaFolder;
    else person.mediaFolder = folder;
  }
  validateStaffData(merged.data);
  const wanted = changes.flatMap((change) => change.items);
  const localFiles = await findLocalMedia(wanted, mediaRoots);
  let offset = 0;
  const missingLocalFiles = [];
  for (const change of changes) {
    change.files = localFiles.slice(offset, offset + change.items.length);
    offset += change.items.length;
    change.items.forEach((item, index) => {
      if (!change.files[index]) missingLocalFiles.push({
        staffId: change.staffId, name: change.name, slot: index + 1,
        sha256: item.sha256, sizeBytes: item.sizeBytes,
      });
    });
  }
  const changed = merged.changedStaffIds.length > 0 || changes.length > 0;
  const summary = {
    schemaVersion: 1, mode,
    result: missingLocalFiles.length ? "blocked" : changed ? "changes" : "no-op",
    changedStaffIds: merged.changedStaffIds,
    mediaChanges: changes.map((item) => ({
      staffId: item.staffId, name: item.name, mediaFolder: item.folder,
      action: item.cleared ? "clear" : "update", count: item.items.length,
      localFiles: item.files,
    })),
    missingLocalFiles,
    remoteOnlyStaffIds: merged.remoteOnlyStaffIds,
    localMissingRemoteStaffIds: merged.localMissingRemoteStaffIds,
    remoteOnlyShowcaseStaffIds: showcase.filter((item) => !staff.has(item.staffId)).map((item) => item.staffId),
  };
  if (mode !== "apply" || !changed || missingLocalFiles.length) return summary;

  const targets = [dataPath];
  if (changes.length) targets.push(receiptsPath, ...changes.map((item) => join(mediaRoot, item.folder)));
  for (const path of targets) await requireCleanTarget(path);
  const stage = await mkdtemp(join(projectRoot, ".staff-sync-"));
  let keepStage = false;
  try {
    const replacements = new Map();
    for (const change of changes) {
      let output = null;
      if (!change.cleared) {
        output = join(stage, change.folder);
        await mkdir(output);
        await buildMedia(change.items.map((item, index) => ({
          path: change.files[index], kind: item.type === "image" ? "photo" : "video",
        })), output, { log: (message) => process.stderr.write(`${message}\n`) });
        for (const [index, item] of change.items.entries()) {
          if ((await stat(change.files[index])).size !== item.sizeBytes ||
              await fileDigest(change.files[index]) !== item.sha256) {
            throw new Error(`${change.name} 第 ${index + 1} 项本地原件已变化，停止更新`);
          }
        }
      }
      replacements.set(change.folder, output);
      receipts.set(change.staffId, {
        staffId: change.staffId, mediaFolder: change.folder,
        selectionSha256: change.selected,
        outputSha256: output ? await folderDigest(output) : null,
      });
    }
    await validateLibrary({
      data: merged.data, mediaRoot, replacements,
      log: (message) => process.stderr.write(`${message}\n`),
    });
    const operations = [...replacements].map(([folder, output]) => ({
      target: join(mediaRoot, folder), staged: output,
    }));
    const mergedText = json(merged.data);
    if (mergedText !== originalText) {
      const staged = join(stage, "data.json");
      await writeFile(staged, mergedText);
      operations.push({ target: dataPath, staged });
    }
    if (changes.length) {
      const staged = join(stage, "receipts.json");
      await writeFile(staged, json({
        schemaVersion: 1,
        profiles: [...receipts.values()].sort((a, b) => a.staffId.localeCompare(b.staffId)),
      }));
      operations.push({ target: receiptsPath, staged });
    }
    if (await readFile(dataPath, "utf8") !== originalText ||
        await optionalText(receiptsPath) !== originalReceipts) {
      throw new Error("生成期间站点数据或同步记录发生变化，拒绝覆盖");
    }
    for (const path of targets) await requireCleanTarget(path);
    const applied = [];
    try {
      for (const [index, operation] of operations.entries()) {
        const backup = join(stage, `backup-${index}`);
        let existed = false;
        try { await rename(operation.target, backup); existed = true; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        const entry = { ...operation, backup, existed, installed: false };
        applied.push(entry);
        if (operation.staged) {
          await rename(operation.staged, operation.target);
          entry.installed = true;
        }
      }
    } catch (error) {
      const errors = [error];
      for (const entry of applied.reverse()) {
        try {
          if (entry.installed) await rm(entry.target, { recursive: true });
          if (entry.existed) await rename(entry.backup, entry.target);
        } catch (restoreError) { errors.push(restoreError); }
      }
      if (errors.length > 1) {
        keepStage = true;
        throw new AggregateError(errors, `更新失败且恢复不完整，备份保留在 ${stage}`);
      }
      throw error;
    }
    return { ...summary, result: "applied" };
  } finally {
    if (!keepStage) await rm(stage, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: "string" }, source: { type: "string" },
    "media-root": { type: "string", multiple: true },
    check: { type: "boolean" }, apply: { type: "boolean" },
    json: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    process.stdout.write("用法：node scripts/sync-staff.mjs [--check | --apply] [--json]\n可选 --config 文件、--source 云节点地址、--media-root 本地根目录（可重复）。\n默认预演，读取 .staff-sync.local.json；只请求价格和展示清单，媒体使用本地原件。\n");
    return;
  }
  if (values.check && values.apply) throw new Error("--check 与 --apply 不能同时使用");
  const configPath = resolve(PROJECT_ROOT, values.config ?? ".staff-sync.local.json");
  const text = await optionalText(configPath);
  if (text === null && values.config) throw new Error(`同步配置不存在：${configPath}`);
  const config = text === null ? {} : JSON.parse(text);
  const source = values.source ?? config.source;
  const roots = values["media-root"] ?? config.mediaRoots;
  if (typeof source !== "string" || !Array.isArray(roots) || !roots.length ||
      roots.some((root) => typeof root !== "string" || !root.trim())) {
    throw new Error("请配置 source 与 mediaRoots；示例见 scripts/staff-sync.example.json");
  }
  const result = await syncStaff({
    source, mediaRoots: roots.map((root) => resolve(PROJECT_ROOT, root)),
    mode: values.apply ? "apply" : "check",
  });
  if (values.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(`结果：${result.result}；价格变化 ${result.changedStaffIds.length} 人，素材变化 ${result.mediaChanges.length} 人\n`);
    for (const item of result.mediaChanges) process.stdout.write(`${item.name}：${item.action === "clear" ? "清空展示" : `${item.count} 项本地素材 → ${item.mediaFolder}`}\n`);
    for (const item of result.missingLocalFiles) process.stderr.write(`等待本地素材同步：${item.name} 第 ${item.slot} 项（${item.sha256}）\n`);
  }
  if (result.result === "blocked") process.exitCode = 1;
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(`人员同步失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
