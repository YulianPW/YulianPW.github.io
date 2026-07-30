/**
 * 页面未收到 tweet 查询参数时使用的演示推文。
 *
 * @type {string}
 */
export const DEFAULT_TWEET_URL =
  "https://x.com/waffles_r_gone/status/2082097551633687021";

/**
 * 已保存到站内的推文封面映射。
 *
 * @type {Readonly<Record<string, string>>}
 */
export const LOCAL_COVER_BY_TWEET_ID = Object.freeze({
  "2082097551633687021": "assets/images/x-embed-demo-cover.svg",
});

/**
 * 外部媒体接口允许返回的 X 官方 CDN 主机。
 *
 * @type {ReadonlySet<string>}
 */
export const ALLOWED_MEDIA_HOSTS = new Set([
  "pbs.twimg.com",
  "video.twimg.com",
]);

/**
 * 站内卡片数据的文档相对地址。
 *
 * @type {string}
 */
export const REPOSITORY_DATA_URL = "assets/data/data.json";
