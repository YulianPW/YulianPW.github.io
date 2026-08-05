import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { MAX_SNAPSHOT_BYTES } from "./staff-details-contract.mjs";
import {
  mergeStaffDetails,
  normalizeStaffDetailsSnapshot,
  verifyMergedStaffDetails,
} from "./staff-details-sync-core.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_DATA_PATH = resolve(PROJECT_ROOT, "assets/data/data.json");
const VALIDATOR_PATH = resolve(SCRIPT_DIR, "validate-staff-data.mjs");
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/**
 * 拉取云端完整快照，严格合并并按 check/apply 模式处理站点读模型。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const fetchResult = await fetchSnapshot(options.source, options.ifNoneMatch);
  if (fetchResult.notModified) {
    console.log(`云端快照未变化（304）：${options.ifNoneMatch}`);
    return;
  }

  const snapshot = normalizeStaffDetailsSnapshot(fetchResult.body);
  const originalText = await readFile(options.dataPath, "utf8");
  const originalData = JSON.parse(originalText);
  const mergeResult = mergeStaffDetails(originalData, snapshot);
  printSummary(snapshot, mergeResult.changedStaffIds, options.mode);
  if (options.mode === "check") {
    return;
  }

  await requireCleanTarget(options.dataPath);
  if (mergeResult.changedStaffIds.length === 0) {
    return;
  }
  await replaceDataAtomically({
    dataPath: options.dataPath,
    originalText,
    mergedData: mergeResult.data,
    snapshot,
  });
  console.log("已原子更新 assets/data/data.json；未执行 commit、push 或部署");
}

function parseArguments(argumentsList) {
  const hasCheck = argumentsList.includes("--check");
  const hasApply = argumentsList.includes("--apply");
  if (hasCheck === hasApply) {
    throw new Error("必须且只能指定 --check 或 --apply");
  }
  const source = requireOption(argumentsList, "--source");
  const dataValue = optionalOption(argumentsList, "--data");
  const ifNoneMatch = optionalOption(argumentsList, "--if-none-match");
  const knownFlags = new Set([
    "--check",
    "--apply",
    "--source",
    "--data",
    "--if-none-match",
  ]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!knownFlags.has(argument)) {
      throw new Error(`未知参数：${argument}`);
    }
    if (["--source", "--data", "--if-none-match"].includes(argument)) {
      index += 1;
    }
  }
  return {
    mode: hasApply ? "apply" : "check",
    source,
    dataPath: dataValue ? resolve(dataValue) : DEFAULT_DATA_PATH,
    ifNoneMatch,
  };
}

async function fetchSnapshot(source, ifNoneMatch) {
  const initialUrl = new URL(source);
  if (initialUrl.protocol === "file:") {
    if (ifNoneMatch) {
      throw new Error("file fixture 不支持 --if-none-match");
    }
    const bytes = await readBoundedFixture(fileURLToPath(initialUrl));
    return { notModified: false, body: JSON.parse(bytes.toString("utf8")) };
  }

  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    requireAllowedUrl(currentUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(currentUrl, {
        headers: ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {},
        redirect: "manual",
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectCount === MAX_REDIRECTS) {
          throw new Error(`快照重定向超过 ${MAX_REDIRECTS} 次`);
        }
        const location = response.headers.get("location");
        if (!location) throw new Error("重定向响应缺少 Location");
        currentUrl = new URL(location, currentUrl);
        continue;
      }
      if (response.status === 304) {
        if (!ifNoneMatch) throw new Error("未发送条件请求却收到 304");
        return { notModified: true, body: null };
      }
      if (!response.ok) {
        throw new Error(`快照请求失败：HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!/^(application\/json|[^;]+\+json)(?:;|$)/i.test(contentType)) {
        throw new Error(`快照 Content-Type 非 JSON：${contentType || "缺失"}`);
      }
      return { notModified: false, body: await readLimitedJson(response) };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("无法完成快照请求");
}

async function readBoundedFixture(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("file fixture 必须是普通文件，拒绝符号链接");
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error("file fixture 必须是普通文件");
    }
    if (metadata.size > MAX_SNAPSHOT_BYTES) {
      throw new Error("快照超过 5 MiB 上限");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new Error("快照超过 5 MiB 上限");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readLimitedJson(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("快照超过 5 MiB 上限");
  }
  if (!response.body) throw new Error("快照响应没有正文");

  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > MAX_SNAPSHOT_BYTES) {
      throw new Error("快照超过 5 MiB 上限");
    }
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireAllowedUrl(url) {
  if (url.protocol === "https:") return;
  const host = url.hostname.toLowerCase();
  const isLoopback =
    url.protocol === "http:" &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1");
  if (!isLoopback) {
    throw new Error("生产 source 必须使用 HTTPS；HTTP 仅允许 loopback fixture");
  }
}

async function requireCleanTarget(dataPath) {
  const targetDirectory = dirname(dataPath);
  const insideWorkTree = (
    await runCommand("git", [
      "-C",
      targetDirectory,
      "rev-parse",
      "--is-inside-work-tree",
    ])
  ).trim();
  if (insideWorkTree !== "true") {
    throw new Error("目标 data.json 不在 Git 工作树中");
  }
  const displayPath = (
    await runCommand("git", ["-C", targetDirectory, "rev-parse", "--show-prefix"])
  ).trim() + basename(dataPath);
  const status = await runCommand("git", [
    "-C",
    targetDirectory,
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    basename(dataPath),
  ]);
  if (status.trim()) {
    throw new Error(`${displayPath} 有未提交变更，拒绝 --apply`);
  }
}

async function replaceDataAtomically({
  dataPath,
  originalText,
  mergedData,
  snapshot,
}) {
  const directory = dirname(dataPath);
  const mode = (await stat(dataPath)).mode & 0o777;
  const temporaryPath = `${dataPath}.staff-details.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const mergedText = `${JSON.stringify(mergedData, null, 2)}\n`;
  try {
    await writeAndSync(temporaryPath, mergedText, mode);
    await runCommand(process.execPath, [VALIDATOR_PATH, "--data", temporaryPath]);
    const stagedData = JSON.parse(await readFile(temporaryPath, "utf8"));
    verifyMergedStaffDetails(stagedData, snapshot);
    await requireUnchangedTarget(dataPath, originalText);
    await rename(temporaryPath, dataPath);
    await syncDirectory(directory);
    const publishedText = await readFile(dataPath, "utf8");
    if (publishedText !== mergedText) {
      throw new Error("写入后检测到并发修改；已保留当前文件，拒绝用旧内容回滚");
    }
    verifyMergedStaffDetails(JSON.parse(publishedText), snapshot);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function requireUnchangedTarget(dataPath, originalText) {
  if ((await readFile(dataPath, "utf8")) !== originalText) {
    throw new Error("执行期间 assets/data/data.json 发生变化，拒绝覆盖");
  }
  await requireCleanTarget(dataPath);
}

async function writeAndSync(path, content, mode) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function runCommand(command, argumentsList) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, argumentsList, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        rejectPromise(
          new Error(
            `${command} 执行失败（${code}）：${stderr.trim() || stdout.trim()}`,
          ),
        );
      }
    });
  });
}

function printSummary(snapshot, changedStaffIds, mode) {
  console.log(`快照版本：${snapshot.snapshotVersion}`);
  console.log(`完整资料数：${snapshot.profiles.length}`);
  console.log(`${mode === "apply" ? "将更新" : "检测到变化"}：${changedStaffIds.length} 人`);
  if (changedStaffIds.length) {
    console.log(`staffId：${changedStaffIds.join(",")}`);
  } else {
    console.log("结果：no-op");
  }
}

function requireOption(argumentsList, flag) {
  const value = optionalOption(argumentsList, flag);
  if (!value) throw new Error(`缺少 ${flag}`);
  return value;
}

function optionalOption(argumentsList, flag) {
  const index = argumentsList.indexOf(flag);
  if (index < 0) return null;
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} 缺少值`);
  }
  return value;
}

await main().catch((error) => {
  console.error(`staff details 同步失败：${error.message}`);
  process.exitCode = 1;
});
