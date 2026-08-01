const LOCAL_MEDIA_ROOT = "assets/media/staff";
const CDN_MEDIA_ROOT =
  "https://cdn.jsdelivr.net/gh/yulianpw/YulianPW.github.io";
const CDN_HEAD_START_MS = 500;
const FOLDER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const MAX_LOCAL_MEDIA_ITEMS = 4;

/** @typedef {"cdn" | "pages"} LocalMediaDeliverySource */

/** @type {{source: LocalMediaDeliverySource, version: string} | null} */
let preferredDelivery = null;

/**
 * 判断当前连接是否应避免额外建立 CDN 连接。
 *
 * @description 省流量和 2G/3G 环境直接复用页面同源连接，避免一个很小的清单
 * 竞速反而增加 DNS、TLS 和无线网络唤醒成本。
 *
 * @returns {boolean} 是否只请求 GitHub Pages 同源素材。
 */
function shouldUseSingleOrigin() {
  const connection = navigator.connection ||
    navigator.mozConnection ||
    navigator.webkitConnection;
  return Boolean(
    connection?.saveData ||
      ["slow-2g", "2g", "3g"].includes(connection?.effectiveType),
  );
}

/**
 * 创建与 fetch 取消语义一致的错误。
 *
 * @returns {Error} 名称为 AbortError 的取消错误。
 */
function createAbortError() {
  const error = new Error("本地素材请求已取消");
  error.name = "AbortError";
  return error;
}

/**
 * 构造当前页面同源的用户媒体清单地址。
 *
 * @param {string} folder - 已校验的媒体目录键。
 * @param {string} version - 媒体内容对应的 Git commit。
 * @returns {URL} 带缓存版本的 GitHub Pages 清单地址。
 * @throws {Error} 页面基址不是当前窗口同源时抛出。
 */
function buildPagesManifestUrl(folder, version) {
  const manifestUrl = new URL(
    `${LOCAL_MEDIA_ROOT}/${encodeURIComponent(folder)}/media.json`,
    document.baseURI,
  );
  if (manifestUrl.origin !== window.location.origin) {
    throw new Error("本站素材清单必须与页面同源");
  }
  if (version) manifestUrl.searchParams.set("v", version);
  return manifestUrl;
}

/**
 * 构造固定到媒体 commit 的 jsDelivr 清单地址。
 *
 * @param {string} folder - 已校验的媒体目录键。
 * @param {string} version - 40 位媒体 Git commit。
 * @returns {URL} 不受 `main` 分支缓存延迟影响的 CDN 清单地址。
 * @throws {Error} 媒体版本不是完整 commit 时抛出。
 */
function buildCdnManifestUrl(folder, version) {
  if (!COMMIT_PATTERN.test(version)) {
    throw new Error("CDN 素材版本必须是完整 Git commit");
  }
  return new URL(
    `${CDN_MEDIA_ROOT}@${version}/${LOCAL_MEDIA_ROOT}/${encodeURIComponent(folder)}/media.json`,
  );
}

/**
 * 将清单中的单层文件名解析成当前用户目录内的可信 URL。
 *
 * @description 清单按外部文件边界处理：拒绝绝对地址、子目录和跨清单源 URL，
 * 避免数据字段把画廊指向任意网络资源。版本参数只用于可变的 Pages 地址；固定
 * commit 的 jsDelivr URL 保持 immutable。
 *
 * @param {unknown} rawFilename - 清单中的候选文件名。
 * @param {URL} manifestUrl - 当前用户清单的绝对 URL。
 * @param {string} cacheVersion - 需要附加到可变地址的缓存版本。
 * @param {ReadonlySet<string>} allowedExtensions - 允许的文件扩展名。
 * @returns {string} 限制在清单目录内的媒体 URL。
 * @throws {Error} 文件名或解析后的 URL 越界时抛出。
 */
function resolveLocalAssetUrl(
  rawFilename,
  manifestUrl,
  cacheVersion,
  allowedExtensions,
) {
  if (
    typeof rawFilename !== "string" ||
    !rawFilename ||
    rawFilename.startsWith(".") ||
    rawFilename.includes("/") ||
    rawFilename.includes("\\")
  ) {
    throw new Error("本地素材文件名无效");
  }

  const extension = rawFilename
    .slice(rawFilename.lastIndexOf("."))
    .toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error("本地素材扩展名无效");
  }

  const assetUrl = new URL(rawFilename, manifestUrl);
  const expectedDirectory = new URL("./", manifestUrl);
  if (
    assetUrl.origin !== manifestUrl.origin ||
    !assetUrl.pathname.startsWith(expectedDirectory.pathname)
  ) {
    throw new Error("本地素材地址越界");
  }
  if (cacheVersion) assetUrl.searchParams.set("v", cacheVersion);
  return assetUrl.href;
}

/**
 * 为 CDN 主地址生成同文件的 GitHub Pages 回退地址。
 *
 * @param {unknown} rawFilename - 清单中的候选文件名。
 * @param {URL | null} fallbackManifestUrl - 同源回退清单；Pages 为主源时为空。
 * @param {string} version - Pages 地址的缓存版本。
 * @param {ReadonlySet<string>} allowedExtensions - 允许的文件扩展名。
 * @returns {string} 回退地址；没有第二来源时为空字符串。
 */
function resolveFallbackAssetUrl(
  rawFilename,
  fallbackManifestUrl,
  version,
  allowedExtensions,
) {
  return fallbackManifestUrl
    ? resolveLocalAssetUrl(
      rawFilename,
      fallbackManifestUrl,
      version,
      allowedExtensions,
    )
    : "";
}

/**
 * 将用户媒体清单收敛为共享画廊数据。
 *
 * @param {object} manifest - `media.json` 的候选内容。
 * @param {URL} manifestUrl - 当前胜出来源的清单 URL。
 * @param {URL | null} fallbackManifestUrl - CDN 素材失败时使用的 Pages 清单 URL。
 * @param {string} displayName - 陪陪显示名称。
 * @param {string} primaryCacheVersion - 主来源媒体地址的缓存版本。
 * @param {string} fallbackCacheVersion - 回退来源媒体地址的缓存版本。
 * @returns {import("../types.js").DynamicMedia} 已校验的本地媒体数据。
 * @throws {Error} 清单版本、数量、尺寸或文件字段无效时抛出。
 */
function normalizeLocalManifest(
  manifest,
  manifestUrl,
  fallbackManifestUrl,
  displayName,
  primaryCacheVersion,
  fallbackCacheVersion,
) {
  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.items) ||
    !manifest.items.length ||
    manifest.items.length > MAX_LOCAL_MEDIA_ITEMS
  ) {
    throw new Error("本地素材清单结构无效");
  }

  const seenUrls = new Set();
  const items = manifest.items.map((item) => {
    const width = Number(item?.width);
    const height = Number(item?.height);
    if (
      (item?.type !== "photo" && item?.type !== "video") ||
      !Number.isFinite(width) ||
      width <= 0 ||
      !Number.isFinite(height) ||
      height <= 0
    ) {
      throw new Error("本地素材类型或尺寸无效");
    }

    const fullExtensions = new Set([
      item.type === "photo" ? ".webp" : ".mp4",
    ]);
    const url = resolveLocalAssetUrl(
      item.url,
      manifestUrl,
      primaryCacheVersion,
      fullExtensions,
    );
    if (seenUrls.has(url)) throw new Error("本地素材地址重复");
    seenUrls.add(url);

    const fallbackUrl = resolveFallbackAssetUrl(
      item.url,
      fallbackManifestUrl,
      fallbackCacheVersion,
      fullExtensions,
    );
    if (item.type === "photo") {
      return {
        type: "photo",
        url,
        fallbackUrl,
        preview: resolveLocalAssetUrl(
          item.preview,
          manifestUrl,
          primaryCacheVersion,
          new Set([".webp"]),
        ),
        fallbackPreview: resolveFallbackAssetUrl(
          item.preview,
          fallbackManifestUrl,
          fallbackCacheVersion,
          new Set([".webp"]),
        ),
        poster: "",
        fallbackPoster: "",
        variants: [],
        width,
        height,
        alt: typeof item.alt === "string" ? item.alt : "",
      };
    }

    if (!Array.isArray(item.variants) || item.variants.length !== 1) {
      throw new Error("本地视频列表档位无效");
    }
    const variant = item.variants[0];
    const bitrate = Number(variant?.bitrate);
    if (!Number.isFinite(bitrate) || bitrate <= 0) {
      throw new Error("本地视频码率无效");
    }
    return {
      type: "video",
      url,
      fallbackUrl,
      preview: "",
      fallbackPreview: "",
      poster: resolveLocalAssetUrl(
        item.poster,
        manifestUrl,
        primaryCacheVersion,
        new Set([".webp"]),
      ),
      fallbackPoster: resolveFallbackAssetUrl(
        item.poster,
        fallbackManifestUrl,
        fallbackCacheVersion,
        new Set([".webp"]),
      ),
      variants: [
        {
          url: resolveLocalAssetUrl(
            variant.url,
            manifestUrl,
            primaryCacheVersion,
            new Set([".mp4"]),
          ),
          fallbackUrl: resolveFallbackAssetUrl(
            variant.url,
            fallbackManifestUrl,
            fallbackCacheVersion,
            new Set([".mp4"]),
          ),
          bitrate,
        },
      ],
      width,
      height,
      alt: typeof item.alt === "string" ? item.alt : "",
    };
  });

  return {
    source: "local",
    items,
    author: {
      name: String(displayName || "本站用户"),
      handle: "",
    },
  };
}

/**
 * 从一个固定来源请求并校验用户媒体清单。
 *
 * @param {LocalMediaDeliverySource} source - jsDelivr 或 GitHub Pages。
 * @param {string} folder - 已校验的媒体目录键。
 * @param {string} displayName - 陪陪显示名称。
 * @param {string} version - 媒体内容对应的完整 Git commit。
 * @param {AbortSignal} signal - 当前来源的独立取消信号。
 * @returns {Promise<import("../types.js").DynamicMedia>} 已解析的媒体数据。
 * @throws {Error} 网络响应、JSON 或清单结构无效时抛出。
 */
async function fetchMediaFromSource(
  source,
  folder,
  displayName,
  version,
  signal,
) {
  const manifestUrl = source === "cdn"
    ? buildCdnManifestUrl(folder, version)
    : buildPagesManifestUrl(folder, version);
  const response = await fetch(manifestUrl, {
    cache: "default",
    credentials: source === "cdn" ? "omit" : "same-origin",
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `${source === "cdn" ? "CDN" : "本站"}素材清单返回 ${response.status}`,
    );
  }

  const fallbackManifestUrl = source === "cdn"
    ? buildPagesManifestUrl(folder, version)
    : null;
  return normalizeLocalManifest(
    await response.json(),
    manifestUrl,
    fallbackManifestUrl,
    displayName,
    source === "pages" ? version : "",
    version,
  );
}

/**
 * 给 jsDelivr 500ms 先发优势，再让 Pages 争夺第一个有效清单。
 *
 * @description 只有很小的 JSON 清单会发生错峰竞速；首个有效结果会取消另一
 * 请求，图片和视频仍只使用胜出来源。任一来源先失败不会阻止另一来源成功。
 *
 * @param {string} folder - 已校验的媒体目录键。
 * @param {string} displayName - 陪陪显示名称。
 * @param {string} version - 媒体内容对应的完整 Git commit。
 * @param {AbortSignal | undefined} parentSignal - 调用方的总取消信号。
 * @returns {Promise<import("../types.js").DynamicMedia>} 首个有效来源的数据。
 */
function fetchWithStaggeredFallback(
  folder,
  displayName,
  version,
  parentSignal,
) {
  return new Promise((resolve, reject) => {
    const controllers = {
      cdn: new AbortController(),
      pages: new AbortController(),
    };
    let settled = false;
    let pagesStarted = false;
    let pendingRequests = 0;
    let fallbackTimer = null;
    let lastError = null;

    /** 清理本次竞速的计时器和上游监听。 */
    function cleanup() {
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      parentSignal?.removeEventListener("abort", abortAll);
    }

    /**
     * 取消两个候选请求并把上游取消传给调用方。
     *
     * @returns {void}
     */
    function abortAll() {
      if (settled) return;
      settled = true;
      cleanup();
      controllers.cdn.abort();
      controllers.pages.abort();
      reject(parentSignal?.reason || createAbortError());
    }

    /**
     * 接受首个有效清单并取消落后的来源。
     *
     * @param {LocalMediaDeliverySource} source - 本轮胜出的来源。
     * @param {import("../types.js").DynamicMedia} media - 已校验媒体数据。
     * @returns {void}
     */
    function accept(source, media) {
      if (settled) return;
      settled = true;
      preferredDelivery = { source, version };
      cleanup();
      const loser = source === "cdn" ? controllers.pages : controllers.cdn;
      loser.abort();
      resolve(media);
    }

    /**
     * 记录一个来源失败，并在所有候选均失败后结束请求。
     *
     * @param {LocalMediaDeliverySource} source - 失败来源。
     * @param {unknown} error - 原始请求错误。
     * @returns {void}
     */
    function rejectSource(source, error) {
      if (settled) return;
      pendingRequests -= 1;
      lastError = error;
      if (source === "cdn" && !pagesStarted) startPages();
      if (pendingRequests > 0) return;

      settled = true;
      cleanup();
      reject(lastError);
    }

    /**
     * 启动一个候选来源，并接入统一的成功/失败处理。
     *
     * @param {LocalMediaDeliverySource} source - 要启动的候选来源。
     * @returns {void}
     */
    function startSource(source) {
      pendingRequests += 1;
      fetchMediaFromSource(
        source,
        folder,
        displayName,
        version,
        controllers[source].signal,
      ).then(
        (media) => accept(source, media),
        (error) => rejectSource(source, error),
      );
    }

    /**
     * 在 CDN 超过先发预算或立即失败后启动同源回退。
     *
     * @returns {void}
     */
    function startPages() {
      if (settled || pagesStarted) return;
      pagesStarted = true;
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      startSource("pages");
    }

    if (parentSignal?.aborted) {
      abortAll();
      return;
    }
    parentSignal?.addEventListener("abort", abortAll, { once: true });
    startSource("cdn");
    fallbackTimer = window.setTimeout(startPages, CDN_HEAD_START_MS);
  });
}

/**
 * 优先复用本页已经胜出的 Pages 来源，并在其失败时尝试 CDN。
 *
 * @param {string} folder - 已校验的媒体目录键。
 * @param {string} displayName - 陪陪显示名称。
 * @param {string} version - 媒体内容对应的完整 Git commit。
 * @param {AbortSignal | undefined} signal - 调用方取消信号。
 * @returns {Promise<import("../types.js").DynamicMedia>} 可用媒体数据。
 */
async function fetchPagesFirst(folder, displayName, version, signal) {
  try {
    return await fetchMediaFromSource(
      "pages",
      folder,
      displayName,
      version,
      signal || new AbortController().signal,
    );
  } catch (pagesError) {
    if (signal?.aborted) throw pagesError;
    const media = await fetchMediaFromSource(
      "cdn",
      folder,
      displayName,
      version,
      signal || new AbortController().signal,
    );
    preferredDelivery = { source: "cdn", version };
    return media;
  }
}

/**
 * 读取一个用户随站点发布的媒体清单。
 *
 * @description 正常网络给固定 commit 的 jsDelivr 500ms 先发优势，再启动
 * GitHub Pages；首个有效来源在当前页面复用。省流量和 2G/3G 只请求同源
 * Pages。CDN 清单中的每个素材同时携带严格同目录的 Pages 回退 URL。
 *
 * @param {string} folder - `data.json.mediaFolder` 的稳定目录键。
 * @param {string} displayName - 陪陪显示名称。
 * @param {string} version - 媒体内容对应的完整 Git commit。
 * @param {AbortSignal} [signal] - 可选取消信号。
 * @returns {Promise<import("../types.js").DynamicMedia>} 可直接交给共享画廊的数据。
 * @throws {Error} 目录键、网络响应或清单结构无效时抛出。
 */
export async function fetchLocalMedia(
  folder,
  displayName,
  version,
  signal,
) {
  if (!FOLDER_PATTERN.test(folder)) {
    throw new Error("本地素材目录键无效");
  }

  const canUseCdn = COMMIT_PATTERN.test(version);
  if (!canUseCdn || shouldUseSingleOrigin()) {
    return fetchMediaFromSource(
      "pages",
      folder,
      displayName,
      version,
      signal || new AbortController().signal,
    );
  }

  const rememberedSource = preferredDelivery?.version === version
    ? preferredDelivery.source
    : null;
  if (rememberedSource === "pages") {
    return fetchPagesFirst(folder, displayName, version, signal);
  }
  return fetchWithStaggeredFallback(folder, displayName, version, signal);
}
