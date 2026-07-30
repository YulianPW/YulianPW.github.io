import { ALLOWED_MEDIA_HOSTS } from "../config.js";

/**
 * 只接受 X 官方媒体 CDN 的 HTTPS 地址。
 *
 * @param {unknown} rawValue - 外部媒体 API 返回的候选地址。
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
 * 将 FxTwitter 响应收敛为页面可直接渲染的媒体数据。
 *
 * @param {object} payload - FxTwitter Status Fetch API 响应。
 * @returns {import("../types.js").DynamicMedia}
 * 已校验并保持原始顺序的媒体清单与作者信息。
 * @throws {Error} 响应无效或没有可安全渲染的原生媒体时抛出。
 */
function normalizeDynamicMedia(payload) {
  const apiTweet = payload?.tweet;
  if (payload?.code !== 200 || !apiTweet) {
    throw new Error("媒体接口未返回可用推文");
  }

  if (!Array.isArray(apiTweet.media?.all)) {
    throw new Error("媒体接口未提供有序素材清单");
  }

  const seenUrls = new Set();
  const items = apiTweet.media.all.flatMap((item) => {
    const type = item?.type;
    if (type !== "photo" && type !== "video" && type !== "gif") {
      return [];
    }

    const url = parseAllowedMediaUrl(item.url);
    if (!url || seenUrls.has(url)) return [];
    seenUrls.add(url);

    const width = Number(item.width);
    const height = Number(item.height);
    return [
      {
        type,
        url,
        poster: parseAllowedMediaUrl(item.thumbnail_url),
        width: Number.isFinite(width) && width > 0 ? width : 16,
        height: Number.isFinite(height) && height > 0 ? height : 9,
        alt: typeof item.alt_text === "string" ? item.alt_text : "",
      },
    ];
  });

  if (!items.length) {
    throw new Error("推文没有可直接渲染的图片或视频");
  }

  const handle = apiTweet.author?.screen_name || "x";
  return {
    items,
    author: {
      name: apiTweet.author?.name || "@" + handle,
      handle,
    },
  };
}

/**
 * 根据推文链接从无密钥兼容接口读取完整媒体清单。
 *
 * @param {Pick<import("../types.js").TweetReference, "id" | "handle">} tweet - 已校验的推文信息。
 * @param {AbortSignal} [signal] - 可选的取消信号；交互式预览会用它终止旧请求。
 * @returns {Promise<import("../types.js").DynamicMedia>} 可渲染的媒体数据。
 */
export async function fetchDynamicMedia(tweet, signal) {
  const handle = encodeURIComponent(tweet.handle || "i");
  const endpoint =
    "https://api.fxtwitter.com/" + handle + "/status/" + tweet.id;
  const response = await fetch(endpoint, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) {
    throw new Error("媒体接口返回 " + response.status);
  }
  return normalizeDynamicMedia(await response.json());
}
