#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const DATA_PATH = join(PROJECT_ROOT, "assets/data/data.json");
const STAFF_MEDIA_ROOT = join(PROJECT_ROOT, "assets/media/staff");
const MEDIA_MANIFEST_NAME = "media.json";
const MAX_ITEMS_PER_FOLDER = 4;
const MAX_FOLDER_BYTES = 30 * 1024 * 1024;
const MAX_SITE_MEDIA_BYTES = 850 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mov", ".mp4"]);
const FOLDER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const FULL_VIDEO_FILTER =
  "scale=w=if(gte(iw\\,ih)\\,-2\\,min(iw\\,720))" +
  ":h=if(gte(iw\\,ih)\\,min(ih\\,720)\\,-2)" +
  ":flags=lanczos:in_range=auto:out_range=tv";
const INLINE_VIDEO_FILTER =
  "scale=w=if(gte(iw\\,ih)\\,-2\\,min(iw\\,360))" +
  ":h=if(gte(iw\\,ih)\\,min(ih\\,360)\\,-2)" +
  ":flags=lanczos:in_range=auto:out_range=tv";
const POSTER_FILTER =
  "scale=w=if(gte(iw\\,ih)\\,min(iw\\,960)\\,-2)" +
  ":h=if(gte(iw\\,ih)\\,-2\\,min(ih\\,960)):flags=lanczos";

/**
 * 执行一个不经过 shell 的媒体处理命令。
 *
 * @description 所有用户提供的路径都作为独立参数传递，避免文件名被解释成
 * shell 语法；失败时仅回显工具错误，不输出素材内容。
 *
 * @param {string} command - 可执行程序名称。
 * @param {string[]} args - 已拆分的命令参数。
 * @returns {{stdout: string, stderr: string}} 命令输出。
 * @throws {Error} 程序不存在或退出码非零时抛出。
 */
function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${command} 不可用：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "未知错误").trim();
    throw new Error(`${command} 执行失败：${detail}`);
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

/**
 * 检查导入模式依赖的本机媒体工具。
 *
 * @returns {void}
 * @throws {Error} 任一依赖不可执行时抛出。
 */
function assertImportTools() {
  runCommand("ffmpeg", ["-version"]);
  runCommand("ffprobe", ["-version"]);
  runCommand("magick", ["-version"]);
  runCommand("cwebp", ["-version"]);
}

/**
 * 读取媒体文件的 ffprobe 结构。
 *
 * @param {string} mediaPath - 图片或视频绝对路径。
 * @returns {object} ffprobe JSON 结果。
 */
function probeMedia(mediaPath) {
  const { stdout } = runCommand("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    mediaPath,
  ]);
  return JSON.parse(stdout);
}

/**
 * 从 FFmpeg SSIM 输出中提取综合分数。
 *
 * @param {string} output - FFmpeg 标准错误文本。
 * @returns {number} 0～1 的 SSIM 分数。
 * @throws {Error} 输出中没有有效分数时抛出。
 */
function parseSsim(output) {
  const match = output.match(/All:([0-9.]+)/);
  const score = Number(match?.[1]);
  if (!Number.isFinite(score)) {
    throw new Error("无法读取压缩质量指标 SSIM");
  }
  return score;
}

/**
 * 比较规范化图片与 WebP 成品的感知质量。
 *
 * @param {string} referencePath - 已完成方向纠正和尺寸限制的参考图。
 * @param {string} outputPath - WebP 成品。
 * @returns {number} 综合 SSIM 分数。
 */
function measureImageSsim(referencePath, outputPath) {
  const result = runCommand("ffmpeg", [
    "-hide_banner",
    "-i",
    referencePath,
    "-i",
    outputPath,
    "-lavfi",
    "[0:v][1:v]ssim",
    "-f",
    "null",
    "-",
  ]);
  return parseSsim(result.stderr);
}

/**
 * 比较源视频缩放结果与高清 MP4 的感知质量。
 *
 * @param {string} sourcePath - 原视频。
 * @param {string} outputPath - 高清 MP4 成品。
 * @returns {number} 综合 SSIM 分数。
 */
function measureVideoSsim(sourcePath, outputPath) {
  const result = runCommand("ffmpeg", [
    "-hide_banner",
    "-i",
    sourcePath,
    "-i",
    outputPath,
    "-lavfi",
    `[0:v]${FULL_VIDEO_FILTER}[reference];[reference][1:v]ssim`,
    "-f",
    "null",
    "-",
  ]);
  return parseSsim(result.stderr);
}

/**
 * 用固定 WebP 参数编码一张已规范化图片。
 *
 * @param {string} sourcePath - 临时 PNG 路径。
 * @param {string} outputPath - WebP 输出路径。
 * @param {number} quality - cwebp 质量参数。
 * @returns {void}
 */
function encodeWebp(sourcePath, outputPath, quality) {
  runCommand("cwebp", [
    "-quiet",
    "-q",
    String(quality),
    "-m",
    "6",
    sourcePath,
    "-o",
    outputPath,
  ]);
}

/**
 * 导入一张图片并生成列表、灯箱两个 WebP 档位。
 *
 * @description 图片先由 ImageMagick 自动纠正方向、删除元数据并限制尺寸；高清
 * 档从 quality 86 开始，SSIM 低于 0.97 时自动提高质量，避免固定参数伤害细节。
 *
 * @param {string} sourcePath - 原图片路径。
 * @param {string} stageDir - 当前用户的临时输出目录。
 * @param {number} ordinal - 从 1 开始的素材序号。
 * @returns {Promise<object>} 可写入本地媒体清单的图片记录。
 */
async function importPhoto(sourcePath, stageDir, ordinal) {
  const prefix = String(ordinal).padStart(2, "0");
  const normalizedFull = join(stageDir, `.${prefix}-full.png`);
  const normalizedInline = join(stageDir, `.${prefix}-inline.png`);
  const fullName = `${prefix}-full.webp`;
  const inlineName = `${prefix}-inline.webp`;
  const fullPath = join(stageDir, fullName);
  const inlinePath = join(stageDir, inlineName);

  runCommand("magick", [
    sourcePath,
    "-auto-orient",
    "-strip",
    "-resize",
    "2200x2200>",
    normalizedFull,
  ]);
  runCommand("magick", [
    sourcePath,
    "-auto-orient",
    "-strip",
    "-resize",
    "960x960>",
    normalizedInline,
  ]);

  let qualityScore = 0;
  for (const quality of [86, 90, 94]) {
    encodeWebp(normalizedFull, fullPath, quality);
    qualityScore = measureImageSsim(normalizedFull, fullPath);
    if (qualityScore >= 0.97) break;
  }
  if (qualityScore < 0.97) {
    throw new Error(`${basename(sourcePath)} 高清图 SSIM 未达到 0.97`);
  }
  encodeWebp(normalizedInline, inlinePath, 82);

  const probe = probeMedia(fullPath);
  const stream = probe.streams?.find((candidate) => candidate.codec_type === "video");
  await rm(normalizedFull, { force: true });
  await rm(normalizedInline, { force: true });
  return {
    type: "photo",
    url: fullName,
    preview: inlineName,
    poster: "",
    variants: [],
    width: Number(stream?.width),
    height: Number(stream?.height),
    alt: "",
  };
}

/**
 * 按指定 CRF 生成浏览器兼容的高清 MP4。
 *
 * @param {string} sourcePath - 原视频路径。
 * @param {string} outputPath - MP4 输出路径。
 * @param {number} crf - libx264 恒定质量参数。
 * @returns {void}
 */
function encodeFullVideo(sourcePath, outputPath, crf) {
  runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    FULL_VIDEO_FILTER,
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-preset",
    "slow",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    outputPath,
  ]);
}

/**
 * 导入一段视频并生成高清、列表和封面三个档位。
 *
 * @description 高清档最高 720p，并用 SSIM 0.95 作为质量门槛；列表档最高
 * 360p，专供接近视口时的低流量预热。两种 MP4 均使用 H.264/AAC、yuv420p
 * 和 faststart，以兼容主流移动浏览器并尽快出现可播放数据。缩放时会将全范围
 * 输入转为电视范围，避免 FFmpeg 将这类素材保留为 yuvj420p 而无法通过部署门禁。
 *
 * @param {string} sourcePath - 原视频路径。
 * @param {string} stageDir - 当前用户的临时输出目录。
 * @param {number} ordinal - 从 1 开始的素材序号。
 * @returns {Promise<object>} 可写入本地媒体清单的视频记录。
 */
async function importVideo(sourcePath, stageDir, ordinal) {
  const prefix = String(ordinal).padStart(2, "0");
  const fullName = `${prefix}-full.mp4`;
  const inlineName = `${prefix}-inline.mp4`;
  const posterName = `${prefix}-poster.webp`;
  const fullPath = join(stageDir, fullName);
  const inlinePath = join(stageDir, inlineName);
  const posterPng = join(stageDir, `.${prefix}-poster.png`);
  const posterPath = join(stageDir, posterName);

  const sourceProbe = probeMedia(sourcePath);
  const duration = Number(sourceProbe.format?.duration);
  if (!sourceProbe.streams?.some((stream) => stream.codec_type === "video")) {
    throw new Error(`${basename(sourcePath)} 不包含视频轨道`);
  }

  let qualityScore = 0;
  for (const crf of [21, 19, 18]) {
    encodeFullVideo(sourcePath, fullPath, crf);
    qualityScore = measureVideoSsim(sourcePath, fullPath);
    if (qualityScore >= 0.95) break;
  }
  if (qualityScore < 0.95) {
    throw new Error(`${basename(sourcePath)} 高清视频 SSIM 未达到 0.95`);
  }

  runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    INLINE_VIDEO_FILTER,
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-preset",
    "slow",
    "-crf",
    "24",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    inlinePath,
  ]);

  const posterTime = Number.isFinite(duration)
    ? Math.min(0.5, Math.max(0, duration / 2))
    : 0;
  runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    String(posterTime),
    "-i",
    sourcePath,
    "-frames:v",
    "1",
    "-vf",
    POSTER_FILTER,
    "-map_metadata",
    "-1",
    posterPng,
  ]);
  encodeWebp(posterPng, posterPath, 82);
  await rm(posterPng, { force: true });

  const fullProbe = probeMedia(fullPath);
  const inlineProbe = probeMedia(inlinePath);
  const fullStream = fullProbe.streams?.find(
    (stream) => stream.codec_type === "video",
  );
  const inlineStream = inlineProbe.streams?.find(
    (stream) => stream.codec_type === "video",
  );
  const inlineBitrate = Number(inlineStream?.bit_rate) ||
    Number(inlineProbe.format?.bit_rate);
  return {
    type: "video",
    url: fullName,
    preview: "",
    poster: posterName,
    variants: [{ url: inlineName, bitrate: inlineBitrate }],
    width: Number(fullStream?.width),
    height: Number(fullStream?.height),
    alt: "",
  };
}

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv - `process.argv` 中脚本名之后的参数。
 * @returns {{check: boolean, replace: boolean, source: string, folder: string}}
 * 规范化后的运行选项。
 */
function parseArguments(argv) {
  const options = { check: false, replace: false, source: "", folder: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
    } else if (argument === "--replace") {
      options.replace = true;
    } else if (argument === "--source") {
      options.source = argv[++index] || "";
    } else if (argument === "--folder") {
      options.folder = argv[++index] || "";
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        "用法：\n" +
          "  node scripts/import-staff-media.mjs --source <目录> --folder <键> [--replace]\n" +
          "  node scripts/import-staff-media.mjs --check",
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

/**
 * 判断路径是否存在。
 *
 * @param {string} targetPath - 待检查路径。
 * @returns {Promise<boolean>} 路径存在时为 true。
 */
async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 读取并自然排序一个来源目录中的 1～4 个媒体文件。
 *
 * @param {string} sourceDir - 来源目录绝对路径。
 * @returns {Promise<Array<{path: string, kind: "photo" | "video"}>>}
 * 有序媒体文件。
 */
async function collectSourceMedia(sourceDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const media = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const extension = extname(entry.name).toLowerCase();
      const kind = IMAGE_EXTENSIONS.has(extension)
        ? "photo"
        : VIDEO_EXTENSIONS.has(extension)
          ? "video"
          : null;
      return kind ? { path: join(sourceDir, entry.name), kind } : null;
    })
    .filter(Boolean)
    .sort((left, right) =>
      basename(left.path).localeCompare(basename(right.path), "zh-CN", {
        numeric: true,
      }),
    );
  if (!media.length || media.length > MAX_ITEMS_PER_FOLDER) {
    throw new Error(
      `来源目录必须包含 1～${MAX_ITEMS_PER_FOLDER} 个图片或视频，当前 ${media.length} 个`,
    );
  }
  return media;
}

/**
 * 校验一个清单文件名是当前目录中的安全相对文件名。
 *
 * @param {unknown} value - 清单候选值。
 * @param {string} extension - 必须使用的扩展名。
 * @returns {string} 已校验文件名。
 * @throws {Error} 值包含目录、控制字符或错误扩展名时抛出。
 */
function parseManifestFilename(value, extension) {
  if (
    typeof value !== "string" ||
    !value ||
    basename(value) !== value ||
    value.startsWith(".") ||
    extname(value).toLowerCase() !== extension
  ) {
    throw new Error(`本地素材文件名无效：${String(value)}`);
  }
  return value;
}

/**
 * 校验一个生成目录及其清单，并统计可部署体积。
 *
 * @param {string} folderPath - 用户素材目录。
 * @returns {Promise<number>} 清单与媒体文件的总字节数。
 */
async function validateMediaFolder(folderPath) {
  const manifestPath = join(folderPath, MEDIA_MANIFEST_NAME);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.items) ||
    !manifest.items.length ||
    manifest.items.length > MAX_ITEMS_PER_FOLDER
  ) {
    throw new Error(`${folderPath} 的 media.json 版本、结构或素材数量无效`);
  }

  const expectedFiles = new Set([MEDIA_MANIFEST_NAME]);
  for (const [index, item] of manifest.items.entries()) {
    if (item?.type !== "photo" && item?.type !== "video") {
      throw new Error(`${folderPath} 第 ${index + 1} 个素材类型无效`);
    }
    if (
      !Number.isFinite(Number(item.width)) ||
      Number(item.width) <= 0 ||
      !Number.isFinite(Number(item.height)) ||
      Number(item.height) <= 0
    ) {
      throw new Error(`${folderPath} 第 ${index + 1} 个素材尺寸无效`);
    }

    if (item.type === "photo") {
      expectedFiles.add(parseManifestFilename(item.url, ".webp"));
      expectedFiles.add(parseManifestFilename(item.preview, ".webp"));
    } else {
      expectedFiles.add(parseManifestFilename(item.url, ".mp4"));
      expectedFiles.add(parseManifestFilename(item.poster, ".webp"));
      if (!Array.isArray(item.variants) || item.variants.length !== 1) {
        throw new Error(`${folderPath} 第 ${index + 1} 个视频档位无效`);
      }
      const variant = item.variants[0];
      expectedFiles.add(parseManifestFilename(variant.url, ".mp4"));
      if (!Number.isFinite(Number(variant.bitrate)) || variant.bitrate <= 0) {
        throw new Error(`${folderPath} 第 ${index + 1} 个视频码率无效`);
      }
    }
  }

  const entries = await readdir(folderPath, { withFileTypes: true });
  const actualFiles = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const unexpected = actualFiles.filter((name) => !expectedFiles.has(name));
  const missing = [...expectedFiles].filter((name) => !actualFiles.includes(name));
  if (unexpected.length || missing.length) {
    throw new Error(
      `${folderPath} 文件与清单不一致：` +
        `缺少 ${missing.join(",") || "无"}；多余 ${unexpected.join(",") || "无"}`,
    );
  }

  let totalBytes = 0;
  for (const name of actualFiles) {
    const filePath = join(folderPath, name);
    totalBytes += (await stat(filePath)).size;
    if (name.endsWith(".webp")) {
      const header = (await readFile(filePath)).subarray(0, 12);
      if (
        header.toString("ascii", 0, 4) !== "RIFF" ||
        header.toString("ascii", 8, 12) !== "WEBP"
      ) {
        throw new Error(`${filePath} 不是有效 WebP`);
      }
    } else if (name.endsWith(".mp4")) {
      const bytes = await readFile(filePath);
      const moovOffset = bytes.indexOf(Buffer.from("moov"));
      const mdatOffset = bytes.indexOf(Buffer.from("mdat"));
      if (moovOffset < 0 || mdatOffset < 0 || moovOffset > mdatOffset) {
        throw new Error(`${filePath} 未使用 faststart`);
      }
      const probe = probeMedia(filePath);
      const video = probe.streams?.find((stream) => stream.codec_type === "video");
      const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
      if (
        video?.codec_name !== "h264" ||
        video?.pix_fmt !== "yuv420p" ||
        (audio && audio.codec_name !== "aac")
      ) {
        throw new Error(`${filePath} 必须使用 H.264/yuv420p 和可选 AAC`);
      }
    }
  }
  if (totalBytes > MAX_FOLDER_BYTES) {
    throw new Error(`${folderPath} 超过 30MB 单用户上限`);
  }
  return totalBytes;
}

/**
 * 校验 data.json 中所有显式关联的本地素材目录。
 *
 * @description 校验只认 `mediaFolder` 稳定键，不根据姓名或社交账号猜测；同时
 * 拒绝未关联目录和超过 850MB 的部署总量，给 GitHub Pages 留出容量余量。
 *
 * @returns {Promise<void>}
 */
async function checkAllMediaFolders() {
  runCommand("ffprobe", ["-version"]);
  const data = JSON.parse(await readFile(DATA_PATH, "utf8"));
  if (!Array.isArray(data.staff)) {
    throw new Error("data.json.staff 必须是数组");
  }
  const folders = [];
  for (const item of data.staff) {
    if (item.mediaFolder === undefined || item.mediaFolder === "") continue;
    if (
      typeof item.mediaFolder !== "string" ||
      !FOLDER_PATTERN.test(item.mediaFolder)
    ) {
      throw new Error(
        `mediaFolder 必须使用小写 ASCII 稳定键：${String(item.mediaFolder)}`,
      );
    }
    folders.push(item.mediaFolder);
  }
  if (new Set(folders).size !== folders.length) {
    throw new Error("data.json 中存在重复 mediaFolder 关联");
  }

  const rootEntries = await readdir(STAFF_MEDIA_ROOT, { withFileTypes: true });
  const actualFolders = rootEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const unreferenced = actualFolders.filter((folder) => !folders.includes(folder));
  if (unreferenced.length) {
    throw new Error(`存在未被 data.json 关联的素材目录：${unreferenced.join(",")}`);
  }

  let totalBytes = 0;
  for (const folder of folders) {
    totalBytes += await validateMediaFolder(join(STAFF_MEDIA_ROOT, folder));
  }
  if (totalBytes > MAX_SITE_MEDIA_BYTES) {
    throw new Error("本地用户素材超过 850MB 部署上限");
  }
  console.log(
    `本地素材有效：${folders.length} 个用户，${(totalBytes / 1024 / 1024).toFixed(2)}MB`,
  );
}

/**
 * 从一个来源目录生成并安装用户专属 Web 素材。
 *
 * @param {{source: string, folder: string, replace: boolean}} options - 导入参数。
 * @returns {Promise<void>}
 */
async function importFolder(options) {
  if (!options.source || !options.folder) {
    throw new Error("导入模式必须同时提供 --source 和 --folder");
  }
  if (!FOLDER_PATTERN.test(options.folder)) {
    throw new Error("--folder 必须是小写 ASCII、数字或中划线组成的稳定键");
  }

  assertImportTools();
  const sourceDir = resolve(options.source);
  const sourceStat = await stat(sourceDir);
  if (!sourceStat.isDirectory()) throw new Error("--source 必须指向目录");
  await mkdir(STAFF_MEDIA_ROOT, { recursive: true });

  const targetDir = join(STAFF_MEDIA_ROOT, options.folder);
  const targetExists = await pathExists(targetDir);
  if (targetExists && !options.replace) {
    throw new Error(`${options.folder} 已存在；确认覆盖时追加 --replace`);
  }

  const media = await collectSourceMedia(sourceDir);
  const stageDir = await mkdtemp(join(STAFF_MEDIA_ROOT, ".import-"));
  let installed = false;
  try {
    const items = [];
    for (const [index, entry] of media.entries()) {
      console.log(`正在压缩：${basename(entry.path)}`);
      items.push(
        entry.kind === "photo"
          ? await importPhoto(entry.path, stageDir, index + 1)
          : await importVideo(entry.path, stageDir, index + 1),
      );
    }
    await writeFile(
      join(stageDir, MEDIA_MANIFEST_NAME),
      `${JSON.stringify({ version: 1, items }, null, 2)}\n`,
    );
    await validateMediaFolder(stageDir);

    if (!targetExists) {
      await rename(stageDir, targetDir);
    } else {
      const backupDir = join(
        STAFF_MEDIA_ROOT,
        `.backup-${options.folder}-${Date.now()}`,
      );
      await rename(targetDir, backupDir);
      try {
        await rename(stageDir, targetDir);
      } catch (error) {
        await rename(backupDir, targetDir);
        throw error;
      }
      try {
        await rm(backupDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`旧素材备份未清理：${backupDir}（${error.message}）`);
      }
    }
    installed = true;
    console.log(`素材已写入：assets/media/staff/${options.folder}`);
  } finally {
    if (!installed && (await pathExists(stageDir))) {
      await rm(stageDir, { recursive: true, force: true });
    }
  }
}

/**
 * 运行素材导入或只读校验。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.check) {
    await checkAllMediaFolders();
    return;
  }
  await importFolder(options);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
