#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const DATA_PATH = join(PROJECT_ROOT, "assets/data/data.json");
const MANIFEST_PATH = join(
  PROJECT_ROOT,
  "assets/data/tweet-media.json",
);
const ALLOWED_MEDIA_HOSTS = new Set([
  "pbs.twimg.com",
  "video.twimg.com",
]);
const CHECK_ONLY = process.argv.includes("--check");

/**
 * 从站点数据中提取去重后的公开 X 推文引用。
 *
 * @param {object} data - `assets/data/data.json` 的解析结果。
 * @returns {{id: string, handle: string, url: string}[]} 按页面顺序排列的推文。
 */
function collectTweetReferences(data) {
  const references = [];
  const seenIds = new Set();

  for (const item of data.staff || []) {
    if (!item.tweet) continue;

    let url;
    try {
      url = new URL(item.tweet);
    } catch (_) {
      throw new Error(`无效推文链接：${item.tweet}`);
    }

    const hostname = url.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/^mobile\./, "");
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      (hostname !== "x.com" && hostname !== "twitter.com") ||
      segments[1] !== "status" ||
      !/^\d+$/.test(segments[2] || "")
    ) {
      throw new Error(`不支持的推文链接：${item.tweet}`);
    }

    const id = segments[2];
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    references.push({
      id,
      handle: segments[0] === "i" ? "i" : segments[0],
      url: `https://x.com/${segments[0]}/status/${id}`,
    });
  }

  return references;
}

/**
 * 只接受清单所需的 X 官方媒体地址。
 *
 * @param {unknown} rawValue - FxTwitter 返回的候选地址。
 * @returns {string} 已校验的 HTTPS 地址；无效地址返回空字符串。
 */
function parseMediaUrl(rawValue) {
  if (typeof rawValue !== "string" || !rawValue) return "";

  try {
    const url = new URL(rawValue);
    if (
      url.protocol !== "https:" ||
      !ALLOWED_MEDIA_HOSTS.has(url.hostname.toLowerCase())
    ) {
      return "";
    }
    return url.href;
  } catch (_) {
    return "";
  }
}

/**
 * 从外部响应中收敛一个可直接播放的 MP4 码率档位。
 *
 * @param {object} rawVariant - FxTwitter 返回的视频档位。
 * @returns {{url: string, bitrate: number} | null} 有效档位或 null。
 */
function normalizeVideoVariant(rawVariant) {
  const url = parseMediaUrl(rawVariant?.url);
  const bitrate = Number(rawVariant?.bitrate);
  if (
    rawVariant?.content_type !== "video/mp4" ||
    !url ||
    !new URL(url).pathname.endsWith(".mp4") ||
    !Number.isFinite(bitrate) ||
    bitrate <= 0
  ) {
    return null;
  }
  return { url, bitrate };
}

/**
 * 读取一条推文的 X CDN 媒体元数据。
 *
 * @description 清单只保存作者、尺寸、封面和视频档位，不下载、转换或生成任何
 * 站内推文预览图。图片和视频由访问者浏览器直接请求 X CDN 并按 HTTP 规则缓存。
 *
 * @param {{id: string, handle: string}} tweet - 规范推文引用。
 * @returns {Promise<object>} 可直接写入静态清单的媒体记录。
 */
async function fetchTweetMediaRecord(tweet) {
  const endpoint =
    `https://api.fxtwitter.com/${encodeURIComponent(tweet.handle)}` +
    `/status/${tweet.id}`;
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
      "User-Agent": "YulianPW.github.io media manifest refresher",
    },
  });
  if (!response.ok) {
    throw new Error(`媒体接口返回 ${response.status}：${tweet.id}`);
  }

  const payload = await response.json();
  const apiTweet = payload?.tweet;
  if (payload?.code !== 200 || !Array.isArray(apiTweet?.media?.all)) {
    throw new Error(`媒体接口未返回有序素材：${tweet.id}`);
  }

  const items = [];
  for (const [index, item] of apiTweet.media.all.entries()) {
    if (
      item?.type !== "photo" &&
      item?.type !== "video" &&
      item?.type !== "gif"
    ) {
      continue;
    }

    const url = parseMediaUrl(item.url);
    if (!url) {
      throw new Error(`媒体地址无效：${tweet.id}/${index + 1}`);
    }

    const poster = parseMediaUrl(item.thumbnail_url);
    const variants = (item.variants || [])
      .map(normalizeVideoVariant)
      .filter(Boolean)
      .sort((left, right) => left.bitrate - right.bitrate);
    if (item.type !== "photo" && (!poster || !variants.length)) {
      throw new Error(`视频元数据不完整：${tweet.id}/${index + 1}`);
    }

    items.push({
      type: item.type,
      url,
      poster,
      variants,
      width: Number(item.width) || 16,
      height: Number(item.height) || 9,
      alt: typeof item.alt_text === "string" ? item.alt_text : "",
    });
  }

  if (!items.length) {
    throw new Error(`推文没有可用媒体：${tweet.id}`);
  }

  const handle = apiTweet.author?.screen_name || tweet.handle;
  return {
    author: {
      name: apiTweet.author?.name || `@${handle}`,
      handle,
    },
    items,
  };
}

/**
 * 检查清单与站点推文完全对应，且只包含可信 X CDN 元数据。
 *
 * @param {{id: string}[]} tweets - 当前 data.json 中的推文。
 * @param {object} manifest - 已解析的静态媒体清单。
 * @returns {void}
 */
function validateManifest(tweets, manifest) {
  if (manifest?.version !== 1 || !manifest.tweets) {
    throw new Error("tweet-media.json 版本或结构无效");
  }

  const expectedIds = tweets.map((tweet) => tweet.id).sort();
  const manifestIds = Object.keys(manifest.tweets).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(manifestIds)) {
    throw new Error(
      `媒体清单推文不一致：data=${expectedIds.join(",")} ` +
        `manifest=${manifestIds.join(",")}`,
    );
  }

  for (const id of expectedIds) {
    const record = manifest.tweets[id];
    if (!Array.isArray(record?.items) || !record.items.length) {
      throw new Error(`媒体清单缺少素材：${id}`);
    }
    for (const [index, item] of record.items.entries()) {
      if (Object.hasOwn(item, "preview")) {
        throw new Error(`媒体清单不得包含站内预览字段：${id}`);
      }
      if (
        item.type !== "photo" &&
        item.type !== "video" &&
        item.type !== "gif"
      ) {
        throw new Error(`媒体清单素材类型无效：${id}/${index + 1}`);
      }
      if (!parseMediaUrl(item.url)) {
        throw new Error(`媒体清单素材地址无效：${id}/${index + 1}`);
      }

      if (item.type !== "photo") {
        if (!parseMediaUrl(item.poster)) {
          throw new Error(`视频封面地址无效：${id}/${index + 1}`);
        }
        const variants = Array.isArray(item.variants) ? item.variants : [];
        if (
          !variants.length ||
          variants.some((variant) => {
            const variantUrl = parseMediaUrl(variant.url);
            return !variantUrl ||
              !new URL(variantUrl).pathname.endsWith(".mp4") ||
              !Number.isFinite(Number(variant.bitrate)) ||
              Number(variant.bitrate) <= 0;
          })
        ) {
          throw new Error(`视频码率档位无效：${id}/${index + 1}`);
        }
        if (
          Math.min(...variants.map((variant) => Number(variant.bitrate))) >
          320000
        ) {
          throw new Error(`视频缺少移动端低码率档位：${id}/${index + 1}`);
        }
      }
    }
  }
}

/**
 * 刷新或只读检查站点媒体元数据清单。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const data = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const tweets = collectTweetReferences(data);

  if (CHECK_ONLY) {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
    validateManifest(tweets, manifest);
    console.log(`媒体清单有效：${tweets.length} 条推文`);
    return;
  }

  const manifest = { version: 1, tweets: {} };
  for (const tweet of tweets) {
    manifest.tweets[tweet.id] = await fetchTweetMediaRecord(tweet);
    console.log(`已刷新推文媒体元数据：${tweet.id}`);
  }
  validateManifest(tweets, manifest);
  await writeFile(
    MANIFEST_PATH,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `媒体清单已写入：${relative(PROJECT_ROOT, MANIFEST_PATH)}`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
