import { REPOSITORY_DATA_URL } from "./config.js";
import { parseTweetUrl } from "./tweet-url.js";

let repositoryDataPromise = null;

/**
 * 读取站内推文卡片资料，用于零组件的轻量预览。
 *
 * @param {Pick<import("./types.js").TweetReference, "id">} tweet - 当前推文。
 * @returns {Promise<object | null>} 与推文 ID 匹配的数据条目。
 */
export async function findRepositoryTweet(tweet) {
  try {
    repositoryDataPromise ??= fetch(REPOSITORY_DATA_URL, {
      cache: "default",
    }).then((response) => {
      if (!response.ok) throw new Error("站内数据读取失败");
      return response.json();
    });

    const data = await repositoryDataPromise;
    return (
      (data.staff || []).find((item) => {
        const storedTweet = parseTweetUrl(item.tweet || "");
        return storedTweet?.id === tweet.id;
      }) || null
    );
  } catch (_) {
    return null;
  }
}
