/**
 * 校验并规范化 X 推文链接。
 *
 * @param {string} rawValue - 用户输入的 x.com 或 twitter.com 链接。
 * @returns {import("./types.js").TweetReference | null}
 * 可用于组件加载的推文信息，并保留可选的媒体深链接序号。
 */
export function parseTweetUrl(rawValue) {
  try {
    const parsedUrl = new URL(rawValue.trim());
    const hostname = parsedUrl.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/^mobile\./, "");
    if (hostname !== "x.com" && hostname !== "twitter.com") {
      return null;
    }

    const segments = parsedUrl.pathname.split("/").filter(Boolean);
    const isStatusPath =
      segments.length >= 3 &&
      segments[1] === "status" &&
      /^\d+$/.test(segments[2]);
    if (!isStatusPath) return null;

    const handle = segments[0] === "i" ? "" : segments[0];
    const id = segments[2];
    const canonicalHandle = handle || "i";
    const mediaType =
      segments[3] === "photo" || segments[3] === "video"
        ? segments[3]
        : "";
    const parsedMediaIndex = Number.parseInt(segments[4] || "", 10);
    const mediaIndex =
      mediaType &&
      Number.isInteger(parsedMediaIndex) &&
      parsedMediaIndex > 0
        ? parsedMediaIndex
        : 0;
    const url =
      "https://x.com/" + canonicalHandle + "/status/" + id;

    return {
      id,
      handle,
      url,
      deepLink: mediaIndex
        ? url + "/" + mediaType + "/" + mediaIndex
        : "",
      mediaType: mediaIndex ? mediaType : "",
      mediaIndex,
    };
  } catch (_) {
    return null;
  }
}
