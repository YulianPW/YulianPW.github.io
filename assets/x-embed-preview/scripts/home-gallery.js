import {
  createMediaGallery,
  preloadMediaGalleryVideos,
} from "./media/gallery.js?v=2026073110";
import { fetchDynamicMedia } from "./media/api.js?v=2026073110";
import { parseTweetUrl } from "./tweet-url.js";

const MEDIA_REQUEST_TIMEOUT_MS = 15000;
const GALLERY_PRELOAD_VIEWPORTS = 1.5;
const VIDEO_METADATA_PRELOAD_VIEWPORTS = 0.75;
const VIDEO_CONTENT_PRELOAD_VIEWPORTS = 0.25;
const MEDIA_ORIGINS = Object.freeze([
  "https://pbs.twimg.com",
  "https://video.twimg.com",
]);

/** @type {Map<string, Promise<import("./types.js").DynamicMedia>>} */
const mediaRequestCache = new Map();

/** @type {HTMLElement[]} */
let pendingMounts = [];
let activeLoads = 0;
let galleryObserver = null;
let videoMetadataObserver = null;
let videoContentObserver = null;
let mediaOriginsWarmed = false;

/**
 * 将视口倍数换算成当前设备可用的 IntersectionObserver 边距。
 *
 * @param {number} viewportMultiplier - 需要提前介入的视口高度倍数。
 * @returns {string} IntersectionObserver 的 rootMargin。
 */
function getObserverRootMargin(viewportMultiplier) {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const verticalMargin = Math.max(
    1,
    Math.round(viewportHeight * viewportMultiplier),
  );
  return `${verticalMargin}px 0px`;
}

/**
 * 移动端一次只连接一条推文，避免 X 请求与正文滚动争抢带宽。
 *
 * @returns {number} 当前允许的最大并发连接数。
 */
function getMaxConcurrentLoads() {
  return window.matchMedia("(max-width: 640px)").matches ? 1 : 2;
}

/**
 * 在正文完成首轮绘制后预先建立 X 媒体 CDN 连接。
 *
 * @description 首页头部只做 DNS 预取，避免第三方握手争抢首屏；画廊模块开始
 * 工作后再注入 preconnect，使视频进入预载距离时可以直接发起媒体请求。
 *
 * @returns {void}
 */
function warmMediaOrigins() {
  if (mediaOriginsWarmed) return;
  mediaOriginsWarmed = true;

  MEDIA_ORIGINS.forEach((origin) => {
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = origin;
    document.head.appendChild(link);
  });
}

/**
 * 判断当前网络是否适合在用户点击前缓冲第一段视频内容。
 *
 * @description 省流量及 2G/3G 网络仍会提前读取 metadata，但不会主动下载
 * 视频内容；明确点击播放时不受此限制。
 *
 * @returns {boolean} 是否允许近视口内容预载。
 */
function canPreloadVideoContent() {
  const connection = navigator.connection ||
    navigator.mozConnection ||
    navigator.webkitConnection;
  return !connection?.saveData &&
    !["slow-2g", "2g", "3g"].includes(connection?.effectiveType);
}

/**
 * 把已生成的画廊接入视频 metadata 和首段内容的两级观察器。
 *
 * @param {HTMLElement} gallery - 已挂载的共享媒体画廊。
 * @returns {void}
 */
function observeGalleryVideoPreload(gallery) {
  if (!gallery.querySelector("video.gallery-mosaic-video")) return;

  if (!("IntersectionObserver" in window)) {
    preloadMediaGalleryVideos(gallery, "metadata");
    if (canPreloadVideoContent()) {
      preloadMediaGalleryVideos(gallery, "auto");
    }
    return;
  }

  videoMetadataObserver?.observe(gallery);
  videoContentObserver?.observe(gallery);
}

/**
 * 按当前视口重建分阶段视频预载观察器，并接管已渲染画廊。
 *
 * @param {ParentNode} root - 当前页面或局部扫描根节点。
 * @returns {void}
 */
function rebuildVideoPreloadObservers(root) {
  videoMetadataObserver?.disconnect();
  videoContentObserver?.disconnect();
  videoMetadataObserver = null;
  videoContentObserver = null;

  if (!("IntersectionObserver" in window)) return;

  videoMetadataObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        videoMetadataObserver?.unobserve(entry.target);
        preloadMediaGalleryVideos(entry.target, "metadata");
      });
    },
    {
      rootMargin: getObserverRootMargin(
        VIDEO_METADATA_PRELOAD_VIEWPORTS,
      ),
      threshold: 0.01,
    },
  );

  if (canPreloadVideoContent()) {
    videoContentObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          videoContentObserver?.unobserve(entry.target);
          preloadMediaGalleryVideos(entry.target, "auto");
        });
      },
      {
        rootMargin: getObserverRootMargin(
          VIDEO_CONTENT_PRELOAD_VIEWPORTS,
        ),
        threshold: 0.01,
      },
    );
  }

  root
    .querySelectorAll(
      ".tweet-gallery-host[data-state='ready'] .media-gallery",
    )
    .forEach((gallery) => observeGalleryVideoPreload(gallery));
}

/**
 * 更新画廊占位区的状态文案。
 *
 * @param {HTMLElement} mount - 当前画廊挂载点。
 * @param {"waiting" | "queued" | "loading" | "ready" | "error"} state - 当前加载状态。
 * @param {string} message - 常规状态的完整文案，或连接状态的前置说明。
 * @returns {void}
 */
function setMountState(mount, state, message) {
  mount.dataset.state = state;
  const status = mount.querySelector(".tweet-gallery-status");
  if (!status) return;

  if (state === "queued" || state === "loading") {
    renderConnectionStatus(mount, status, message);
    return;
  }

  status.className = "tweet-gallery-status";
  status.textContent = message;
}

/**
 * 使用画廊自带的 X 来源模板渲染连接状态。
 *
 * @description 从不参与布局的模板克隆来源链接与网络提示，让加载区保留连接
 * 说明，同时使左上角继续显示原有的媒体操作提示。
 *
 * @param {HTMLElement} mount - 当前画廊挂载点。
 * @param {HTMLElement} status - 用于承载连接状态的元素。
 * @param {string} message - 显示在来源徽标前的连接说明。
 * @returns {void}
 */
function renderConnectionStatus(mount, status, message) {
  const showcase = mount.closest(".tweet-showcase");
  const sourceTemplate = showcase?.querySelector(
    ".tweet-connection-source-template",
  );

  status.className = "tweet-gallery-status tweet-gallery-status--connection";
  if (!(sourceTemplate instanceof HTMLTemplateElement)) {
    status.textContent = `${message} X · 需开🪜`;
    return;
  }

  const copy = document.createElement("span");
  copy.textContent = message;
  status.replaceChildren(copy, sourceTemplate.content.cloneNode(true));
}

/**
 * 恢复画廊的标准加载占位内容。
 *
 * @param {HTMLElement} mount - 需要重新加载的画廊挂载点。
 * @returns {void}
 */
function renderLoadingState(mount) {
  const loader = document.createElement("span");
  loader.className = "tweet-gallery-loader";
  loader.setAttribute("aria-hidden", "true");

  const status = document.createElement("span");
  status.className = "tweet-gallery-status";

  mount.setAttribute("role", "status");
  mount.setAttribute("aria-live", "polite");
  mount.replaceChildren(loader, status);
  renderConnectionStatus(mount, status, "正在连接");
}

/**
 * 按推文 ID 复用媒体请求。
 *
 * @description 首页同时保留桌面表格和移动卡片 DOM，同一条推文可能出现两次；
 * 缓存 Promise 可避免响应返回前产生重复请求；单次请求最多等待 15 秒，失败时
 * 清除缓存以允许用户重试。
 *
 * @param {import("./types.js").TweetReference} tweet - 已校验的推文引用。
 * @returns {Promise<import("./types.js").DynamicMedia>} 可供多个挂载点复用的媒体数据。
 */
function getCachedDynamicMedia(tweet) {
  const cachedRequest = mediaRequestCache.get(tweet.id);
  if (cachedRequest) return cachedRequest;

  const requestController = new AbortController();
  const timeoutId = window.setTimeout(() => {
    requestController.abort();
  }, MEDIA_REQUEST_TIMEOUT_MS);
  const request = fetchDynamicMedia(tweet, requestController.signal)
    .catch((error) => {
      mediaRequestCache.delete(tweet.id);
      throw error;
    })
    .finally(() => {
      window.clearTimeout(timeoutId);
    });
  mediaRequestCache.set(tweet.id, request);
  return request;
}

/**
 * 渲染失败说明、重试入口和原推文链接。
 *
 * @param {HTMLElement} mount - 加载失败的画廊挂载点。
 * @param {import("./types.js").TweetReference | null} tweet - 可选的规范推文引用。
 * @returns {void}
 */
function renderGalleryError(mount, tweet) {
  mount.dataset.state = "error";
  mount.removeAttribute("role");

  const copy = document.createElement("span");
  copy.className = "tweet-gallery-error-copy";
  copy.textContent = "X 媒体未加载，请确认已开🪜后重试。";

  const actions = document.createElement("span");
  actions.className = "tweet-gallery-error-actions";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "tweet-gallery-retry";
  retry.textContent = "重新加载";
  retry.addEventListener("click", () => {
    renderLoadingState(mount);
    setMountState(mount, "waiting", "正在重新连接 X…");
    queueMount(mount);
  });
  actions.appendChild(retry);

  if (tweet) {
    const sourceLink = document.createElement("a");
    sourceLink.href = tweet.deepLink || tweet.url;
    sourceLink.target = "_blank";
    sourceLink.rel = "noreferrer";
    sourceLink.textContent = "打开原推文";
    actions.appendChild(sourceLink);
  }

  mount.replaceChildren(copy, actions);
}

/**
 * 将一个可见占位区替换为动态媒体画廊。
 *
 * @param {HTMLElement} mount - 当前可见的画廊挂载点。
 * @returns {Promise<void>}
 */
async function hydrateMount(mount) {
  const tweet = parseTweetUrl(mount.dataset.tweetUrl || "");
  if (!tweet) {
    renderGalleryError(mount, null);
    return;
  }

  setMountState(mount, "loading", "正在连接");
  try {
    const media = await getCachedDynamicMedia(tweet);
    if (!mount.isConnected) return;

    mount.dataset.state = "ready";
    mount.removeAttribute("role");
    mount.removeAttribute("aria-live");
    mount.removeAttribute("aria-label");
    const gallery = createMediaGallery(tweet, media);

    // 首页已在紧凑头部提供原推文入口，移除共享组件的来源栏以避免重复信息。
    gallery.querySelector(".gallery-source")?.remove();
    mount.replaceChildren(gallery);
    observeGalleryVideoPreload(gallery);
  } catch (_) {
    if (mount.isConnected) renderGalleryError(mount, tweet);
  }
}

/**
 * 启动等待队列中的可见画廊，限制并行请求对移动网络的占用。
 *
 * @returns {void}
 */
function drainQueue() {
  while (activeLoads < getMaxConcurrentLoads() && pendingMounts.length) {
    const mount = pendingMounts.shift();
    if (!mount?.isConnected) continue;

    if (mount.offsetParent === null) {
      setMountState(mount, "waiting", "接近这里自动预载");
      galleryObserver?.observe(mount);
      continue;
    }

    activeLoads += 1;
    hydrateMount(mount).finally(() => {
      activeLoads -= 1;
      drainQueue();
    });
  }
}

/**
 * 将画廊挂载点加入去重后的加载队列。
 *
 * @param {HTMLElement} mount - 等待加载的画廊挂载点。
 * @returns {void}
 */
function queueMount(mount) {
  if (!mount.isConnected || mount.dataset.state !== "waiting") return;
  setMountState(mount, "queued", "即将连接");
  pendingMounts.push(mount);
  drainQueue();
}

/**
 * 扫描首页中新生成的画廊占位区，并在接近视口时加载媒体。
 *
 * @description 排序、缓存刷新和断点切换都会重新生成或显隐卡片；调用本函数会
 * 重建可见性观察，但保留已完成的媒体请求缓存和正在执行的有限并发队列。
 *
 * @param {ParentNode} [root=document] - 要扫描的页面或局部容器。
 * @returns {void}
 */
export function refreshHomeMediaGalleries(root = document) {
  warmMediaOrigins();
  galleryObserver?.disconnect();
  rebuildVideoPreloadObservers(root);
  pendingMounts = pendingMounts.filter(
    (mount) => mount.isConnected && mount.dataset.state === "queued",
  );

  const mounts = root.querySelectorAll(
    ".tweet-gallery-host[data-state='waiting']",
  );
  if (!mounts.length) return;

  if (!("IntersectionObserver" in window)) {
    mounts.forEach((mount) => queueMount(mount));
    return;
  }

  galleryObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        galleryObserver?.unobserve(entry.target);
        queueMount(entry.target);
      });
    },
    {
      rootMargin: getObserverRootMargin(GALLERY_PRELOAD_VIEWPORTS),
      threshold: 0.01,
    },
  );
  mounts.forEach((mount) => galleryObserver.observe(mount));
}
