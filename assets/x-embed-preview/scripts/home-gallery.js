import { createMediaGallery } from "./media/gallery.js";
import { fetchDynamicMedia } from "./media/api.js";
import { parseTweetUrl } from "./tweet-url.js";

const ROOT_MARGIN = "480px 0px";
const MAX_CONCURRENT_LOADS = 2;

/** @type {Map<string, Promise<import("./types.js").DynamicMedia>>} */
const mediaRequestCache = new Map();

/** @type {HTMLElement[]} */
let pendingMounts = [];
let activeLoads = 0;
let galleryObserver = null;

/**
 * 更新画廊占位区的状态文案。
 *
 * @param {HTMLElement} mount - 当前画廊挂载点。
 * @param {"waiting" | "queued" | "loading" | "ready" | "error"} state - 当前加载状态。
 * @param {string} message - 提供给用户和读屏软件的状态说明。
 * @returns {void}
 */
function setMountState(mount, state, message) {
  mount.dataset.state = state;
  const status = mount.querySelector(".tweet-gallery-status");
  if (status) status.textContent = message;
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
  status.textContent = "正在读取素材…";

  mount.setAttribute("role", "status");
  mount.setAttribute("aria-live", "polite");
  mount.replaceChildren(loader, status);
}

/**
 * 按推文 ID 复用媒体请求。
 *
 * @description 首页同时保留桌面表格和移动卡片 DOM，同一条推文可能出现两次；
 * 缓存 Promise 可避免响应返回前产生重复请求，失败时则清除缓存以允许重试。
 *
 * @param {import("./types.js").TweetReference} tweet - 已校验的推文引用。
 * @returns {Promise<import("./types.js").DynamicMedia>} 可供多个挂载点复用的媒体数据。
 */
function getCachedDynamicMedia(tweet) {
  const cachedRequest = mediaRequestCache.get(tweet.id);
  if (cachedRequest) return cachedRequest;

  const request = fetchDynamicMedia(tweet).catch((error) => {
    mediaRequestCache.delete(tweet.id);
    throw error;
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
  copy.textContent = "暂时无法读取媒体，可以重试或前往 X 查看。";

  const actions = document.createElement("span");
  actions.className = "tweet-gallery-error-actions";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "tweet-gallery-retry";
  retry.textContent = "重新加载";
  retry.addEventListener("click", () => {
    renderLoadingState(mount);
    setMountState(mount, "waiting", "正在读取素材…");
    queueMount(mount);
  });
  actions.appendChild(retry);

  if (tweet) {
    const sourceLink = document.createElement("a");
    sourceLink.href = tweet.deepLink || tweet.url;
    sourceLink.target = "_blank";
    sourceLink.rel = "noreferrer";
    sourceLink.textContent = "在 X 查看";
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

  setMountState(mount, "loading", "正在读取图片和视频…");
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
  while (activeLoads < MAX_CONCURRENT_LOADS && pendingMounts.length) {
    const mount = pendingMounts.shift();
    if (!mount?.isConnected) continue;

    if (mount.offsetParent === null) {
      setMountState(mount, "waiting", "滚动到这里加载素材");
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
  setMountState(mount, "queued", "即将读取图片和视频…");
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
  galleryObserver?.disconnect();
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
    { rootMargin: ROOT_MARGIN, threshold: 0.01 },
  );
  mounts.forEach((mount) => galleryObserver.observe(mount));
}
