import { DEFAULT_TWEET_URL } from "./config.js?v=2026073110";
import {
  createLocalCard,
  getLocalCardData,
} from "./local-card.js?v=2026073110";
import { renderDynamicMediaGallery } from "./media/preview.js?v=2026080101";
import { findRepositoryTweet } from "./repository.js";
import { parseTweetUrl } from "./tweet-url.js";
import { setRailState } from "./ui-state.js";
import {
  renderFullTweet,
  renderVideoTweet,
} from "./x-widgets.js";

/**
 * 初始化 X 推文五种展示方式的预览页。
 *
 * @description 入口模块只负责页面状态和模块编排。媒体解析、画廊、
 * X Widgets 与本地卡片均由独立模块维护。
 *
 * @returns {void}
 */
export function initializePreviewPage() {
  const previewForm = document.getElementById("previewForm");
  const tweetUrlInput = document.getElementById("tweetUrl");
  const formMessage = document.getElementById("formMessage");
  const fullPreview = document.getElementById("fullPreview");
  const videoPreview = document.getElementById("videoPreview");
  const mediaGalleryPreview = document.getElementById(
    "mediaGalleryPreview",
  );
  const localPreview = document.getElementById("localPreview");
  const deferredPreview = document.getElementById("deferredPreview");
  const deferredNative = document.getElementById("deferredNative");
  let activeRenderId = 0;

  /**
   * 根据当前链接同时刷新五种预览。
   *
   * @param {import("./types.js").TweetReference} tweet - 已校验的推文信息。
   * @returns {Promise<void>} 五种预览完成首轮状态更新时结束。
   */
  async function renderAllPreviews(tweet) {
    const renderId = ++activeRenderId;
    const isCurrent = () => renderId === activeRenderId;
    formMessage.classList.remove("is-error");
    formMessage.textContent = "正在预览 " + tweet.url;
    setRailState("fullRail", "loading", "正在请求推文");
    setRailState("videoRail", "loading", "正在请求视频");
    setRailState("galleryRail", "loading", "正在解析媒体");
    setRailState("localRail", "ready", "0 个 X 组件");
    setRailState("deferredRail", "dormant", "尚未请求推文");
    deferredNative.replaceChildren();

    const repositoryItemPromise = findRepositoryTweet(tweet);
    const fullPromise = renderFullTweet(tweet, fullPreview, isCurrent);
    const videoPromise = renderVideoTweet(
      tweet,
      videoPreview,
      isCurrent,
    );
    const galleryPromise = renderDynamicMediaGallery(
      tweet,
      mediaGalleryPreview,
      isCurrent,
    );
    const repositoryItem = await repositoryItemPromise;
    if (!isCurrent()) return;

    const cardData = getLocalCardData(tweet, repositoryItem);
    const expandTweet = async () => {
      setRailState("deferredRail", "loading", "正在请求推文");
      const isReady = await renderFullTweet(
        tweet,
        deferredNative,
        isCurrent,
      );
      if (!isCurrent()) return null;
      setRailState(
        "deferredRail",
        isReady ? "ready" : "error",
        isReady ? "已按需加载" : "加载失败",
      );
      return isReady;
    };

    localPreview.replaceChildren(
      createLocalCard(tweet, cardData, "link"),
    );
    deferredPreview.replaceChildren(
      createLocalCard(tweet, cardData, "expand", expandTweet),
    );
    const repositoryMessage = cardData.hasLocalData
      ? "已匹配站内作者资料；原生组件的加载状态见下方轨道。"
      : "这条推文尚无站内文字资料，先展示卡片结构；原生组件仍会使用真实推文。";

    const [fullReady, videoReady, galleryResult] = await Promise.all([
      fullPromise,
      videoPromise,
      galleryPromise,
    ]);
    if (!isCurrent()) return;

    setRailState(
      "fullRail",
      fullReady ? "ready" : "error",
      fullReady ? "X 组件已加载" : "组件加载失败",
    );
    setRailState(
      "videoRail",
      videoReady ? "ready" : "error",
      videoReady ? "X 视频已加载" : "视频不可用",
    );
    setRailState(
      "galleryRail",
      galleryResult.ready ? "ready" : "error",
      galleryResult.ready
        ? galleryResult.count + " 个素材可播放"
        : "动态媒体不可用",
    );
    formMessage.textContent = galleryResult.ready
      ? "动态画廊已读取 " +
        galleryResult.count +
        " 个素材。" +
        repositoryMessage
      : "动态画廊未能读取媒体。" + repositoryMessage;
  }

  previewForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const tweet = parseTweetUrl(tweetUrlInput.value);
    if (!tweet) {
      formMessage.classList.add("is-error");
      formMessage.textContent =
        "请输入有效的 x.com 或 twitter.com 推文链接，例如 https://x.com/账号/status/推文ID";
      tweetUrlInput.focus();
      return;
    }

    tweetUrlInput.value = tweet.deepLink || tweet.url;
    renderAllPreviews(tweet);
  });

  const initialTweet = parseTweetUrl(
    new URLSearchParams(window.location.search).get("tweet") ||
      DEFAULT_TWEET_URL,
  );
  if (initialTweet) {
    tweetUrlInput.value = initialTweet.deepLink || initialTweet.url;
    renderAllPreviews(initialTweet);
  }
}

initializePreviewPage();
