import { createLoadingState, renderWidgetError } from "./ui-state.js";

let xWidgetsPromise = null;

/**
 * 按需加载 X 官方 widgets.js，并复用同一个加载 Promise。
 *
 * @returns {Promise<object>} X Widgets 全局对象。
 */
function loadXWidgets() {
  if (window.twttr?.widgets) return Promise.resolve(window.twttr);
  if (xWidgetsPromise) return xWidgetsPromise;

  xWidgetsPromise = new Promise((resolve, reject) => {
    const existingScript = document.getElementById("x-wjs");
    const script = existingScript || document.createElement("script");
    const timeoutId = window.setTimeout(() => {
      reject(new Error("X 组件加载超时"));
    }, 15000);

    window.twttr = window.twttr || {
      _e: [],
      ready(callback) {
        this._e.push(callback);
      },
    };

    window.twttr.ready((widgetsApi) => {
      window.clearTimeout(timeoutId);
      resolve(widgetsApi);
    });

    if (!existingScript) {
      script.id = "x-wjs";
      script.async = true;
      script.src = "https://platform.x.com/widgets.js";
      script.charset = "utf-8";
      script.addEventListener("error", () => {
        window.clearTimeout(timeoutId);
        reject(new Error("无法连接 X 组件"));
      });
      document.head.appendChild(script);
    }
  }).catch((error) => {
    xWidgetsPromise = null;
    throw error;
  });

  return xWidgetsPromise;
}

/**
 * 等待 X Publish 把媒体模式标记转换为 iframe。
 *
 * @param {HTMLElement} mount - 视频组件挂载点。
 * @returns {Promise<void>} iframe 出现时完成。
 */
function waitForWidgetFrame(mount) {
  return new Promise((resolve, reject) => {
    if (mount.querySelector("iframe")) {
      resolve();
      return;
    }

    const observer = new MutationObserver(() => {
      if (!mount.querySelector("iframe")) return;
      observer.disconnect();
      window.clearTimeout(timeoutId);
      resolve();
    });
    const timeoutId = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error("X 视频组件加载超时"));
    }, 15000);
    observer.observe(mount, { childList: true, subtree: true });
  });
}

/**
 * 生成完整原生推文组件。
 *
 * @param {import("./types.js").TweetReference} tweet - 当前推文。
 * @param {HTMLElement} container - 组件挂载容器。
 * @param {() => boolean} isCurrent - 判断异步结果是否仍属于当前渲染。
 * @returns {Promise<boolean>} 是否成功生成组件。
 */
export async function renderFullTweet(tweet, container, isCurrent) {
  const mount = document.createElement("div");
  mount.className = "native-mount";
  mount.appendChild(
    createLoadingState("正在连接 X 完整推文组件…"),
  );
  container.replaceChildren(mount);

  try {
    const widgetsApi = await loadXWidgets();
    if (!isCurrent()) return false;

    mount.replaceChildren();
    const widget = await widgetsApi.widgets.createTweet(tweet.id, mount, {
      align: "center",
      conversation: "none",
      dnt: true,
      lang: "zh-cn",
    });
    if (!widget) throw new Error("X 未返回可显示的推文");
    return true;
  } catch (_) {
    if (!isCurrent()) return false;
    renderWidgetError(mount, tweet, "完整推文暂时无法加载。");
    return false;
  }
}

/**
 * 使用 X Publish 的 data-media-max-width 模式生成仅视频预览。
 *
 * @param {import("./types.js").TweetReference} tweet - 当前推文。
 * @param {HTMLElement} container - 组件挂载容器。
 * @param {() => boolean} isCurrent - 判断异步结果是否仍属于当前渲染。
 * @returns {Promise<boolean>} 是否成功生成组件。
 */
export async function renderVideoTweet(tweet, container, isCurrent) {
  const mount = document.createElement("div");
  mount.className = "native-mount";
  mount.appendChild(createLoadingState("正在连接 X 视频组件…"));
  container.replaceChildren(mount);

  try {
    const widgetsApi = await loadXWidgets();
    if (!isCurrent()) return false;

    const blockquote = document.createElement("blockquote");
    blockquote.className = "twitter-tweet";
    blockquote.dataset.mediaMaxWidth = "560";
    blockquote.dataset.dnt = "true";
    blockquote.dataset.lang = "zh-cn";
    const link = document.createElement("a");
    link.href = tweet.url;
    blockquote.appendChild(link);
    mount.replaceChildren(blockquote);

    widgetsApi.widgets.load(mount);
    await waitForWidgetFrame(mount);
    return true;
  } catch (_) {
    if (!isCurrent()) return false;
    renderWidgetError(
      mount,
      tweet,
      "这条推文没有可嵌入视频，或 X 视频组件暂时不可用。",
    );
    return false;
  }
}
