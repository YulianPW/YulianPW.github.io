/**
 * 页面未收到 tweet 查询参数时使用的演示推文。
 *
 * @type {string}
 */
export const DEFAULT_TWEET_URL =
  "https://x.com/loli_yl/status/2083117823048515721";

/**
 * 媒体静态清单和模块缓存共同使用的发布版本。
 *
 * @description 首页会在解析 X 链接前预取同版本清单；修改清单结构或媒体加载
 * 逻辑时应同步递增，避免 GitHub Pages 的旧缓存混用。
 *
 * @type {string}
 */
export const MEDIA_ASSET_VERSION = "2026073110";

/**
 * 随站点保留的 X 推文媒体清单入口。
 *
 * @description 首页 X 来源当前停用，清单为空；实验页和未来恢复流程仍使用
 * 这个稳定地址，因此不删除导出或清单文件。
 *
 * @type {string}
 */
export const MEDIA_MANIFEST_URL =
  `assets/data/tweet-media.json?v=${MEDIA_ASSET_VERSION}`;

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
