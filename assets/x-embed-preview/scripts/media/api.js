import {
  ALLOWED_MEDIA_HOSTS,
  MEDIA_MANIFEST_URL,
} from "../config.js?v=2026073110";

const MEDIA_CACHE_KEY_PREFIX = "tweet_media_cache:v1:";
const MEDIA_CACHE_TTL_MS = 1000 * 60 * 60 * 6;

/** @type {Promise<object | null> | null} */
let mediaManifestPromise = null;

/**
 * 只接受 X 官方媒体 CDN 的 HTTPS 地址。
 *
 * @param {unknown} rawValue - 外部媒体 API 或静态清单中的候选地址。
 * @returns {string} 校验后的绝对地址；不可信地址返回空字符串。
 */
function parseAllowedMediaUrl(rawValue) {
  if (typeof rawValue !== "string" || !rawValue) return "";

  try {
    const mediaUrl = new URL(rawValue);
    const hostname = mediaUrl.hostname.toLowerCase();
    if (
      mediaUrl.protocol !== "https:" ||
      !ALLOWED_MEDIA_HOSTS.has(hostname)
    ) {
      return "";
    }
    return mediaUrl.href;
  } catch (_) {
    return "";
  }
}

/**
 * 收敛一个 MP4 码率档位。
 *
 * @param {unknown} rawVariant - FxTwitter 或静态清单中的候选档位。
 * @returns {import("../types.js").MediaVariant | null} 已校验档位。
 */
function normalizeMediaVariant(rawVariant) {
  if (
    rawVariant?.content_type &&
    rawVariant.content_type !== "video/mp4"
  ) {
    return null;
  }
  const url = parseAllowedMediaUrl(rawVariant?.url);
  const bitrate = Number(rawVariant?.bitrate);
  if (
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
 * 将媒体记录收敛为页面可直接渲染的可信数据。
 *
 * @description 静态清单、本地缓存和实时 FxTwitter 响应都经过同一边界校验，
 * 避免缓存命中时绕过 URL 主机及字段形态约束。
 *
 * @param {object} rawRecord - 含作者与有序素材列表的候选记录。
 * @returns {import("../types.js").DynamicMedia} 已校验媒体记录。
 * @throws {Error} 没有可安全展示的素材时抛出。
 */
function normalizeMediaRecord(rawRecord) {
  if (!Array.isArray(rawRecord?.items)) {
    throw new Error("媒体记录未提供有序素材清单");
  }

  const seenUrls = new Set();
  const items = rawRecord.items.flatMap((item) => {
    const type = item?.type;
    if (type !== "photo" && type !== "video" && type !== "gif") {
      return [];
    }

    const url = parseAllowedMediaUrl(item.url);
    if (!url || seenUrls.has(url)) return [];
    seenUrls.add(url);

    const width = Number(item.width);
    const height = Number(item.height);
    const variants = (item.variants || [])
      .map(normalizeMediaVariant)
      .filter(Boolean)
      .filter(
        (variant, index, all) =>
          all.findIndex((candidate) => candidate.url === variant.url) ===
          index,
      )
      .sort((left, right) => left.bitrate - right.bitrate);

    return [
      {
        type,
        url,
        poster: parseAllowedMediaUrl(item.poster || item.thumbnail_url),
        variants,
        width: Number.isFinite(width) && width > 0 ? width : 16,
        height: Number.isFinite(height) && height > 0 ? height : 9,
        alt: typeof item.alt === "string"
          ? item.alt
          : typeof item.alt_text === "string"
            ? item.alt_text
            : "",
      },
    ];
  });

  if (!items.length) {
    throw new Error("推文没有可直接渲染的图片或视频");
  }

  const rawHandle = rawRecord.author?.handle ||
    rawRecord.author?.screen_name ||
    "x";
  const handle = String(rawHandle).replace(/[^A-Za-z0-9_]/g, "") || "x";
  return {
    items,
    author: {
      name: String(rawRecord.author?.name || `@${handle}`),
      handle,
    },
  };
}

/**
 * 将 FxTwitter Status Fetch API 响应转换为共享媒体记录。
 *
 * @param {object} payload - FxTwitter Status Fetch API 响应。
 * @returns {import("../types.js").DynamicMedia} 已校验媒体记录。
 * @throws {Error} 响应无效时抛出。
 */
function normalizeFxTwitterPayload(payload) {
  const apiTweet = payload?.tweet;
  if (payload?.code !== 200 || !apiTweet) {
    throw new Error("媒体接口未返回可用推文");
  }

  return normalizeMediaRecord({
    author: {
      name: apiTweet.author?.name,
      handle: apiTweet.author?.screen_name,
    },
    items: apiTweet.media?.all,
  });
}

/**
 * 读取随 GitHub Pages 发布的静态媒体清单。
 *
 * @description 清单 Promise 在所有推文之间复用；读取失败或目标推文尚未入库时
 * 返回 null，让调用方继续使用六小时本地缓存或实时 FxTwitter 回退。
 *
 * @param {string} tweetId - 推文数字 ID。
 * @returns {Promise<import("../types.js").DynamicMedia | null>}
 */
async function readManifestMedia(tweetId) {
  mediaManifestPromise ??= fetch(MEDIA_MANIFEST_URL, {
    cache: "default",
    credentials: "same-origin",
  })
    .then((response) => {
      if (!response.ok) throw new Error("站内媒体清单读取失败");
      return response.json();
    })
    .catch(() => null);

  const manifest = await mediaManifestPromise;
  const record = manifest?.version === 1
    ? manifest.tweets?.[tweetId]
    : null;
  if (!record) return null;

  try {
    return normalizeMediaRecord(record);
  } catch (_) {
    return null;
  }
}

/**
 * 从浏览器六小时缓存读取实时解析结果。
 *
 * @param {string} tweetId - 推文数字 ID。
 * @returns {import("../types.js").DynamicMedia | null} 有效缓存或 null。
 */
function readCachedMedia(tweetId) {
  const key = `${MEDIA_CACHE_KEY_PREFIX}${tweetId}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (
      !cached ||
      !Number.isFinite(cached.savedAt) ||
      Date.now() - cached.savedAt >= MEDIA_CACHE_TTL_MS
    ) {
      localStorage.removeItem(key);
      return null;
    }
    return normalizeMediaRecord(cached.media);
  } catch (_) {
    try {
      localStorage.removeItem(key);
    } catch (_) {}
    return null;
  }
}

/**
 * 保存实时解析结果，供刷新页面和返回访问直接复用。
 *
 * @param {string} tweetId - 推文数字 ID。
 * @param {import("../types.js").DynamicMedia} media - 已校验媒体数据。
 * @returns {void}
 */
function writeCachedMedia(tweetId, media) {
  try {
    localStorage.setItem(
      `${MEDIA_CACHE_KEY_PREFIX}${tweetId}`,
      JSON.stringify({ savedAt: Date.now(), media }),
    );
  } catch (_) {}
}

/**
 * 根据推文链接优先读取站内媒体清单，再回退到实时兼容接口。
 *
 * @description 首访已入库推文不再依赖 FxTwitter JSON；任意实验推文仍可实时
 * 解析，成功结果缓存六小时。视频和图片 URL 始终由 X 官方 CDN 提供。
 *
 * @param {Pick<import("../types.js").TweetReference, "id" | "handle">} tweet - 已校验的推文信息。
 * @param {AbortSignal} [signal] - 可选取消信号；交互式预览会终止旧请求。
 * @returns {Promise<import("../types.js").DynamicMedia>} 可渲染媒体数据。
 */
export async function fetchDynamicMedia(tweet, signal) {
  const manifestMedia = await readManifestMedia(tweet.id);
  if (signal?.aborted) {
    throw signal.reason || new DOMException("请求已取消", "AbortError");
  }
  if (manifestMedia) return manifestMedia;

  const cachedMedia = readCachedMedia(tweet.id);
  if (cachedMedia) return cachedMedia;

  const handle = encodeURIComponent(tweet.handle || "i");
  const endpoint =
    `https://api.fxtwitter.com/${handle}/status/${tweet.id}`;
  const response = await fetch(endpoint, {
    cache: "no-store",
    credentials: "omit",
    headers: { Accept: "application/json" },
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) {
    throw new Error(`媒体接口返回 ${response.status}`);
  }

  const media = normalizeFxTwitterPayload(await response.json());
  writeCachedMedia(tweet.id, media);
  return media;
}
