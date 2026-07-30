/**
 * @typedef {Object} TweetReference
 * @property {string} id - X 推文数字 ID。
 * @property {string} handle - 推文作者账号；未知时为空字符串。
 * @property {string} url - 不含媒体序号的规范推文地址。
 * @property {string} deepLink - 可选的 photo/video 深链接。
 * @property {"photo" | "video" | ""} mediaType - 深链接声明的素材类型。
 * @property {number} mediaIndex - 从 1 开始的素材序号；未声明时为 0。
 */

/**
 * @typedef {Object} MediaItem
 * @property {"photo" | "video" | "gif"} type - 素材类型。
 * @property {string} url - X 官方 CDN 上的媒体地址。
 * @property {string} poster - 视频或动图的封面地址。
 * @property {number} width - 原始媒体宽度。
 * @property {number} height - 原始媒体高度。
 * @property {string} alt - 媒体替代文本。
 */

/**
 * @typedef {Object} DynamicMedia
 * @property {MediaItem[]} items - 保持推文原始顺序的媒体清单。
 * @property {{name: string, handle: string}} author - 推文作者展示信息。
 */

/**
 * @typedef {Object} LocalCardData
 * @property {string} name - 卡片作者显示名。
 * @property {string} handle - 卡片作者账号。
 * @property {string} avatar - 可选头像地址。
 * @property {string} text - 卡片摘要。
 * @property {string} cover - 本地封面地址。
 * @property {boolean} hasLocalData - 是否同时匹配站内条目与本地封面。
 */

export {};
