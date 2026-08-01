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
 * @typedef {Object} MediaVariant
 * @property {string} url - 列表播放器使用的 MP4 地址。
 * @property {string} [fallbackUrl] - 主地址失败后使用的同文件备用地址。
 * @property {number} bitrate - 每秒比特率，用于按展示尺寸选择清晰度。
 */

/**
 * @typedef {Object} MediaItem
 * @property {"photo" | "video" | "gif"} type - 素材类型。
 * @property {string} url - 灯箱使用的高清媒体地址。
 * @property {string} [fallbackUrl] - 高清媒体主地址失败后的备用地址。
 * @property {string} preview - 可选的列表图片地址；为空时复用 url。
 * @property {string} [fallbackPreview] - 列表图片主地址失败后的备用地址。
 * @property {string} poster - 视频或动图封面地址。
 * @property {string} [fallbackPoster] - 视频封面主地址失败后的备用地址。
 * @property {MediaVariant[]} variants - 可供列表播放器选择的 MP4 码率档位。
 * @property {number} width - 原始媒体宽度。
 * @property {number} height - 原始媒体高度。
 * @property {string} alt - 媒体替代文本。
 */

/**
 * @typedef {Object} DynamicMedia
 * @property {"x" | "local"} source - 素材来自 X CDN 或本站用户目录。
 * @property {MediaItem[]} items - 保持推文原始顺序的媒体清单。
 * @property {{name: string, handle: string}} author - 推文作者展示信息。
 */

/**
 * @typedef {Object} LocalCardData
 * @property {string} name - 卡片作者显示名。
 * @property {string} handle - 卡片作者账号。
 * @property {string} avatar - 可选头像地址。
 * @property {string} text - 卡片摘要。
 * @property {string} cover - 可选的长期站点封面地址；不用于推文预览缓存。
 * @property {boolean} hasLocalData - 是否匹配到站内文字资料。
 */

export {};
