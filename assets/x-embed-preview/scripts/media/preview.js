import { createLoadingState, renderWidgetError } from "../ui-state.js";
import { fetchDynamicMedia } from "./api.js?v=2026080104";
import { createMediaGallery } from "./gallery.js?v=2026080105";

let activeMediaController = null;

/**
 * 请求并渲染动态媒体画廊。
 *
 * @param {import("../types.js").TweetReference} tweet - 当前推文。
 * @param {HTMLElement} container - 画廊挂载容器。
 * @param {() => boolean} isCurrent - 判断异步结果是否仍属于当前渲染。
 * @returns {Promise<{ready: boolean, count: number}>} 加载结果与媒体数量。
 */
export async function renderDynamicMediaGallery(
  tweet,
  container,
  isCurrent,
) {
  activeMediaController?.abort();
  const requestController = new AbortController();
  activeMediaController = requestController;
  const timeoutId = window.setTimeout(() => {
    requestController.abort();
  }, 15000);
  container.replaceChildren(
    createLoadingState("正在请求动态媒体清单…"),
  );

  try {
    const mediaData = await fetchDynamicMedia(
      tweet,
      requestController.signal,
    );
    if (!isCurrent()) return { ready: false, count: 0 };

    container.replaceChildren(createMediaGallery(tweet, mediaData));
    return { ready: true, count: mediaData.items.length };
  } catch (_) {
    if (!isCurrent()) return { ready: false, count: 0 };

    renderWidgetError(
      container,
      tweet,
      "动态媒体接口暂时不可用，或这条推文没有可公开读取的媒体。",
    );
    return { ready: false, count: 0 };
  } finally {
    window.clearTimeout(timeoutId);
    if (activeMediaController === requestController) {
      activeMediaController = null;
    }
  }
}
