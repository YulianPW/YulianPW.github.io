const LOCAL_MEDIA_ROOT = "assets/media/staff";
const FOLDER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_LOCAL_MEDIA_ITEMS = 4;

/**
 * 将清单中的单层文件名解析成当前用户目录内的同源 URL。
 *
 * @description 本地清单虽然由站点发布，仍按外部文件边界处理：拒绝绝对地址、
 * 子目录和跨源 URL，避免数据字段把画廊指向任意网络资源。
 *
 * @param {unknown} rawFilename - 清单中的候选文件名。
 * @param {URL} manifestUrl - 当前用户清单的绝对 URL。
 * @param {string} version - Git 部署版本，用于刷新浏览器缓存。
 * @param {ReadonlySet<string>} allowedExtensions - 允许的文件扩展名。
 * @returns {string} 带版本参数的同源媒体 URL。
 * @throws {Error} 文件名或解析后的 URL 越界时抛出。
 */
function resolveLocalAssetUrl(
  rawFilename,
  manifestUrl,
  version,
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
    assetUrl.origin !== window.location.origin ||
    !assetUrl.pathname.startsWith(expectedDirectory.pathname)
  ) {
    throw new Error("本地素材地址越界");
  }
  if (version) assetUrl.searchParams.set("v", version);
  return assetUrl.href;
}

/**
 * 将用户目录清单收敛为共享画廊数据。
 *
 * @param {object} manifest - `media.json` 的候选内容。
 * @param {URL} manifestUrl - 当前清单的绝对 URL。
 * @param {string} displayName - 陪陪显示名称。
 * @param {string} version - Git 部署版本。
 * @returns {import("../types.js").DynamicMedia} 已校验的本地媒体数据。
 * @throws {Error} 清单版本、数量、尺寸或文件字段无效时抛出。
 */
function normalizeLocalManifest(
  manifest,
  manifestUrl,
  displayName,
  version,
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

    const url = resolveLocalAssetUrl(
      item.url,
      manifestUrl,
      version,
      new Set([item.type === "photo" ? ".webp" : ".mp4"]),
    );
    if (seenUrls.has(url)) throw new Error("本地素材地址重复");
    seenUrls.add(url);

    if (item.type === "photo") {
      return {
        type: "photo",
        url,
        preview: resolveLocalAssetUrl(
          item.preview,
          manifestUrl,
          version,
          new Set([".webp"]),
        ),
        poster: "",
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
      preview: "",
      poster: resolveLocalAssetUrl(
        item.poster,
        manifestUrl,
        version,
        new Set([".webp"]),
      ),
      variants: [
        {
          url: resolveLocalAssetUrl(
            variant.url,
            manifestUrl,
            version,
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
 * 读取一个用户随 GitHub Pages 发布的本地媒体清单。
 *
 * @description 清单和素材均限制为当前站点同源地址；调用方负责请求复用、超时
 * 和失败后的 X 回退。媒体 URL 带当前 Git 版本，替换同名成品后不会命中旧缓存。
 *
 * @param {string} folder - `data.json.mediaFolder` 的稳定目录键。
 * @param {string} displayName - 陪陪显示名称。
 * @param {string} version - 当前部署版本。
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

  const manifestUrl = new URL(
    `${LOCAL_MEDIA_ROOT}/${encodeURIComponent(folder)}/media.json`,
    document.baseURI,
  );
  if (version) manifestUrl.searchParams.set("v", version);
  if (manifestUrl.origin !== window.location.origin) {
    throw new Error("本地素材清单必须与页面同源");
  }

  const response = await fetch(manifestUrl, {
    cache: "default",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    throw new Error(`本地素材清单返回 ${response.status}`);
  }
  return normalizeLocalManifest(
    await response.json(),
    manifestUrl,
    displayName,
    version,
  );
}
