import { createMediaLightbox } from "./lightbox.js?v=2026080105";
import {
  claimMediaPlayback,
  pauseActiveMediaPlayback,
  releaseMediaPlayback,
} from "./playback-controller.js?v=2026080104";

const VIDEO_PRELOAD_PRIORITY = Object.freeze({
  none: 0,
  metadata: 1,
  auto: 2,
});

/** @type {WeakMap<HTMLElement, ReturnType<typeof createMosaicVideoLoadController>>} */
const galleryVideoLoadControllers = new WeakMap();

/**
 * 解析媒体深链接在画廊中的初始位置。
 *
 * @param {import("../types.js").TweetReference | null} tweet - 可选的推文深链接信息。
 * @param {import("../types.js").DynamicMedia} data - 已校验媒体数据。
 * @returns {{index: number, matches: boolean}} 初始索引及深链接是否有效。
 */
function resolveInitialMedia(tweet, data) {
  if (!tweet) return { index: 0, matches: false };
  const requestedIndex = tweet.mediaIndex - 1;
  const requestedItem = data.items[requestedIndex];
  const matches =
    tweet.mediaType === "photo"
      ? requestedItem?.type === "photo"
      : tweet.mediaType === "video"
        ? requestedItem?.type === "video" ||
          requestedItem?.type === "gif"
        : false;
  return {
    index: matches ? requestedIndex : 0,
    matches,
  };
}

/**
 * 为当前展示尺寸和网络偏好选择列表播放码率。
 *
 * @description 移动端拼图使用最低 MP4 档位，桌面端使用不高于 832kbps 的
 * 最清晰档位；省流量或 2G/3G 网络统一选择最低档。灯箱不调用本函数，仍加载
 * item.url 指向的高清文件。
 *
 * @param {import("../types.js").MediaItem} item - 当前视频素材。
 * @returns {{url: string, fallbackUrl?: string, bitrate: number}}
 * 列表播放器使用的主地址、备用地址和码率。
 */
function selectInlineVideoSource(item) {
  const variants = [...(item.variants || [])].sort(
    (left, right) => left.bitrate - right.bitrate,
  );
  if (!variants.length) {
    return {
      url: item.url,
      fallbackUrl: item.fallbackUrl || "",
      bitrate: 0,
    };
  }

  const connection = navigator.connection ||
    navigator.mozConnection ||
    navigator.webkitConnection;
  const constrainedNetwork =
    connection?.saveData ||
    ["slow-2g", "2g", "3g"].includes(connection?.effectiveType);
  const targetBitrate =
    constrainedNetwork || window.matchMedia("(max-width: 640px)").matches
      ? 288000
      : 832000;
  const withinTarget = variants.filter(
    (variant) => variant.bitrate <= targetBitrate,
  );
  return withinTarget.at(-1) || variants[0];
}

/**
 * 为拼图选择 X 图片 CDN 的适配尺寸，保留灯箱使用的原图地址。
 *
 * @description 移动端拼图宽度有限，small 已足够清晰；桌面端使用 medium。
 * 这里只改写 X 图片的 name 参数，不生成或保存站内派生图片。
 *
 * @param {import("../types.js").MediaItem} item - 当前图片素材。
 * @returns {{url: string, fallbackUrl: string}} 拼图使用的主地址和备用地址。
 */
function selectInlinePhotoSources(item) {
  const fallbackUrl = item.fallbackPreview || item.fallbackUrl || "";
  if (item.preview) return { url: item.preview, fallbackUrl };
  try {
    const source = new URL(item.url);
    if (
      source.hostname === "pbs.twimg.com" &&
      source.pathname.startsWith("/media/")
    ) {
      source.searchParams.set(
        "name",
        window.matchMedia("(max-width: 640px)").matches
          ? "small"
          : "medium",
      );
    }
    return { url: source.href, fallbackUrl };
  } catch (_) {
    return { url: item.url, fallbackUrl };
  }
}

/**
 * 返回拼图状态中使用的素材来源说明。
 *
 * @param {import("../types.js").DynamicMedia["source"]} source - 媒体来源。
 * @returns {string} 本站或 X 的简短提示。
 */
function getMediaSourceNote(source) {
  return source === "local" ? "本站素材" : "来源 X · 需开🪜";
}

/**
 * 将视频提升到指定预加载等级，且不重复重置已采用更高等级的缓冲。
 *
 * @param {HTMLVideoElement} video - 拼图内的视频节点。
 * @param {"metadata" | "auto"} preloadMode - 目标预加载等级。
 * @returns {void}
 */
function attachMosaicVideoSource(video, preloadMode) {
  const source = video.dataset.inlineSrc;
  if (!source) return;

  const currentMode = video.dataset.preloadMode || "none";
  if (
    VIDEO_PRELOAD_PRIORITY[currentMode] >=
      VIDEO_PRELOAD_PRIORITY[preloadMode] &&
    video.getAttribute("src")
  ) {
    return;
  }

  const sourceWasAttached = Boolean(video.getAttribute("src"));
  video.preload = preloadMode;
  if (!sourceWasAttached) video.src = source;
  video.dataset.preloadMode = preloadMode;

  // 已有可持续播放的缓冲时不重启媒体选择，避免升级 preload 反而丢掉进度。
  const shouldLoad =
    !sourceWasAttached ||
    (preloadMode === "auto" &&
      video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
  if (!shouldLoad) return;

  // preload 只是浏览器提示；首次挂载或缓冲不足时显式进入媒体选择流程。
  try {
    video.load();
  } catch (_) {}
}

/**
 * 释放尚未形成可播放缓冲的推测下载。
 *
 * @description 只中止暂停、尚无播放进度、仍在联网且未达到 HAVE_FUTURE_DATA
 * 的 auto 请求；已经开始或可播放的视频保留进度和缓冲，避免为了抢占带宽
 * 反而浪费已经完成的下载。
 *
 * @param {HTMLVideoElement} video - 可能占用主加载槽的视频。
 * @returns {void}
 */
function releaseUnreadySpeculativeLoad(video) {
  const isUnreadyAutoLoad =
    video.dataset.preloadMode === "auto" &&
    video.paused &&
    video.currentTime === 0 &&
    video.networkState === HTMLMediaElement.NETWORK_LOADING &&
    video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
  if (!isUnreadyAutoLoad) return;

  video.removeAttribute("src");
  video.preload = "none";
  video.dataset.preloadMode = "none";

  // 清空当前媒体选择会中止旧请求；poster 和 data-inline-src 仍用于稍后恢复。
  try {
    video.load();
  } catch (_) {}
}

/**
 * 为一个拼图画廊管理唯一的主动视频加载槽。
 *
 * @description metadata 仍可覆盖所有视频；auto 级内容预热只由当前槽位持有者
 * 主导。软意图不会打扰正在播放的视频，pointerdown 和明确点击则允许目标抢占。
 *
 * @returns {{
 *   register: (video: HTMLVideoElement) => void,
 *   warmFirst: () => void,
 *   warmForIntent: (video: HTMLVideoElement, takeover: boolean) => void,
 *   activate: (video: HTMLVideoElement) => void,
 *   deactivate: (video: HTMLVideoElement) => void
 * }} 画廊视频加载控制器。
 */
function createMosaicVideoLoadController() {
  /** @type {HTMLVideoElement[]} */
  const videos = [];
  /** @type {HTMLVideoElement | null} */
  let warmVideo = null;
  /** @type {HTMLVideoElement | null} */
  let activeVideo = null;

  /**
   * 把主动内容加载槽交给指定视频。
   *
   * @param {HTMLVideoElement} video - 新的预热或播放目标。
   * @param {boolean} takeover - 是否来自按下或点击等明确用户意图。
   * @returns {void}
   */
  function claim(video, takeover) {
    if (!videos.includes(video)) return;
    if (!takeover && activeVideo && !activeVideo.paused) return;

    const previousWarmVideo = warmVideo;
    warmVideo = video;
    if (
      previousWarmVideo &&
      previousWarmVideo !== video &&
      previousWarmVideo !== activeVideo
    ) {
      releaseUnreadySpeculativeLoad(previousWarmVideo);
    }
    attachMosaicVideoSource(video, "auto");
  }

  return {
    register(video) {
      videos.push(video);
    },
    warmFirst() {
      const firstVideo = videos[0];
      if (firstVideo) claim(firstVideo, false);
    },
    warmForIntent(video, takeover) {
      claim(video, takeover);
    },
    activate(video) {
      activeVideo = video;
      claim(video, true);
    },
    deactivate(video) {
      if (activeVideo === video) activeVideo = null;
      if (warmVideo !== video) releaseUnreadySpeculativeLoad(video);
    },
  };
}

/**
 * 创建点击后进入灯箱的拼图图片。
 *
 * @param {import("../types.js").MediaItem} item - 图片素材。
 * @param {number} index - 素材索引。
 * @param {import("../types.js").DynamicMedia["source"]} source - 媒体来源。
 * @param {(index: number, trigger: HTMLElement) => void} openLightbox - 灯箱入口。
 * @returns {HTMLButtonElement} 拼图图片按钮。
 */
function createMosaicPhoto(item, index, source, openLightbox) {
  const mosaicItem = document.createElement("button");
  mosaicItem.type = "button";
  mosaicItem.className =
    "gallery-mosaic-item gallery-mosaic-item--photo";
  mosaicItem.setAttribute(
    "aria-label",
    "放大第 " + (index + 1) + " 张图片",
  );

  const image = document.createElement("img");
  image.className = "gallery-mosaic-image";
  image.alt = "";
  image.loading = index === 0 ? "eager" : "lazy";
  image.decoding = "async";

  const status = document.createElement("span");
  status.className = "gallery-mosaic-status";
  status.dataset.state = "loading";
  status.textContent = `加载中 · ${getMediaSourceNote(source)}`;
  image.addEventListener("load", () => {
    image.classList.add("is-loaded");
    status.hidden = true;
  });
  image.addEventListener("error", () => {
    const fallbackSource = image.dataset.fallbackSrc;
    if (fallbackSource) {
      delete image.dataset.fallbackSrc;
      status.hidden = false;
      status.dataset.state = "loading";
      status.textContent = "正在切换 Pages 备用源";
      image.src = fallbackSource;
      return;
    }

    image.hidden = true;
    status.hidden = false;
    status.dataset.state = "error";
    status.textContent = source === "local"
      ? "本站图片加载失败"
      : "X 媒体未加载 · 请确认已开🪜";
  });
  const inlineSources = selectInlinePhotoSources(item);
  if (inlineSources.fallbackUrl) {
    image.dataset.fallbackSrc = inlineSources.fallbackUrl;
  }
  image.src = inlineSources.url;

  mosaicItem.append(image, status);
  mosaicItem.addEventListener("click", () => {
    openLightbox(index, mosaicItem);
  });
  return mosaicItem;
}

/**
 * 创建可直接播放并带独立放大入口的拼图视频。
 *
 * @param {import("../types.js").MediaItem} item - 视频或动图素材。
 * @param {number} index - 素材索引。
 * @param {import("../types.js").DynamicMedia["author"]} author - 作者信息。
 * @param {import("../types.js").DynamicMedia["source"]} source - 媒体来源。
 * @param {ReturnType<typeof createMosaicVideoLoadController>} videoLoadController -
 * 当前画廊的主动加载槽控制器。
 * @param {(activeVideo: HTMLVideoElement) => void} pauseOtherVideos - 播放前暂停其他视频。
 * @param {(index: number, trigger: HTMLElement) => void} openLightbox - 灯箱入口。
 * @returns {{element: HTMLDivElement, video: HTMLVideoElement, reset: () => void}}
 * 拼图节点、播放器及恢复预览态的方法。
 */
function createMosaicVideo(
  item,
  index,
  author,
  source,
  videoLoadController,
  pauseOtherVideos,
  openLightbox,
) {
  const mosaicItem = document.createElement("div");
  mosaicItem.className =
    "gallery-mosaic-item gallery-mosaic-item--video";
  mosaicItem.setAttribute("role", "group");
  mosaicItem.setAttribute(
    "aria-label",
    "第 " + (index + 1) + " 段视频",
  );

  const video = document.createElement("video");
  video.className = "gallery-mosaic-video";
  video.playsInline = true;
  video.preload = "none";
  video.setAttribute("webkit-playsinline", "");
  video.setAttribute("disablepictureinpicture", "");
  video.setAttribute("controlslist", "nodownload noremoteplayback");
  if ("disablePictureInPicture" in video) {
    video.disablePictureInPicture = true;
  }
  if ("disableRemotePlayback" in video) {
    video.disableRemotePlayback = true;
  }
  if (item.poster) video.poster = item.poster;
  const inlineSource = selectInlineVideoSource(item);
  video.dataset.inlineSrc = inlineSource.url;
  if (inlineSource.fallbackUrl) {
    video.dataset.inlineFallbackSrc = inlineSource.fallbackUrl;
  }
  video.dataset.inlineBitrate = String(inlineSource.bitrate);
  video.dataset.preloadMode = "none";
  video.setAttribute(
    "aria-label",
    author.name + " 的第 " + (index + 1) + " 段视频",
  );

  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "gallery-mosaic-play";
  playButton.setAttribute(
    "aria-label",
    "播放第 " + (index + 1) + " 段视频",
  );
  const playLabel = document.createElement("span");
  playLabel.className = "gallery-mosaic-play-label";
  playLabel.hidden = true;
  playButton.appendChild(playLabel);

  const expandButton = document.createElement("button");
  expandButton.type = "button";
  expandButton.className = "gallery-mosaic-expand";
  expandButton.setAttribute(
    "aria-label",
    "放大播放第 " + (index + 1) + " 段视频",
  );
  expandButton.textContent = "⤢";

  const status = document.createElement("span");
  status.className = "gallery-mosaic-status";
  status.dataset.state = "loading";
  status.textContent = `加载中 · ${getMediaSourceNote(source)}`;

  let hasPreviewFrame = false;
  let previewAction = "play";
  let playbackRequested = false;
  let switchingSource = false;

  /**
   * 同步预览按钮的可见文案和无障碍名称。
   *
   * @param {"play" | "continue" | "replay"} action - 当前允许的播放动作。
   * @returns {void}
   */
  function setPreviewAction(action) {
    previewAction = action;
    const actionLabel = action === "continue"
      ? "继续播放"
      : action === "replay"
        ? "再次播放"
        : "播放";
    playButton.dataset.action = action;
    playButton.setAttribute(
      "aria-label",
      actionLabel + "第 " + (index + 1) + " 段视频",
    );
    playLabel.textContent = actionLabel;
    playLabel.hidden = action === "play";
  }
  setPreviewAction("play");

  /**
   * 恢复只显示站内播放与放大入口的预览态。
   *
   * @param {"play" | "continue" | "replay"} [action=previewAction] - 恢复后的播放动作。
   * @returns {void}
   */
  function showPreviewControls(action = previewAction) {
    setPreviewAction(action);
    video.removeAttribute("controls");
    playButton.hidden = false;
    expandButton.hidden = false;
    status.hidden = hasPreviewFrame || video.readyState >= 2;
  }

  /**
   * 暂停当前视频并移除原生控件，供其他视频或灯箱接管交互。
   *
   * @returns {void}
   */
  function resetPlayback() {
    const nextAction = video.ended
      ? "replay"
      : video.currentTime > 0
        ? "continue"
        : "play";
    playbackRequested = false;
    video.pause();
    videoLoadController.deactivate(video);
    showPreviewControls(nextAction);
  }

  /**
   * 在 CDN 视频失败后切换到同文件的 Pages 地址。
   *
   * @description 预载失败只继续读取备用源；用户已经点过播放时尝试恢复播放，
   * 并在完整视频中保留已走过的时间点。备用源只消费一次，避免错误循环。
   *
   * @returns {boolean} 是否找到了尚未尝试的备用地址。
   */
  function switchToFallbackSource() {
    const fallbackSource = video.dataset.inlineFallbackSrc;
    if (!fallbackSource) return false;

    delete video.dataset.inlineFallbackSrc;
    const resumeTime = Number.isFinite(video.currentTime)
      ? video.currentTime
      : 0;
    const shouldResume = playbackRequested;
    const preloadMode = shouldResume
      ? "auto"
      : video.dataset.preloadMode === "none"
        ? "metadata"
        : video.dataset.preloadMode;

    switchingSource = true;
    releaseMediaPlayback(video);
    videoLoadController.deactivate(video);
    video.dataset.inlineSrc = fallbackSource;
    video.dataset.preloadMode = preloadMode;
    video.preload = preloadMode;
    video.src = fallbackSource;
    status.hidden = false;
    status.dataset.state = "loading";
    status.textContent = "正在切换 Pages 备用源";

    if (resumeTime > 0) {
      video.addEventListener(
        "loadedmetadata",
        () => {
          if (Number.isFinite(video.duration)) {
            video.currentTime = Math.min(resumeTime, video.duration);
          }
        },
        { once: true },
      );
    }

    try {
      video.load();
      if (shouldResume) {
        const playback = video.play();
        if (playback) {
          playback.catch(() => {
            switchingSource = false;
            resetPlayback();
          });
        }
      } else {
        switchingSource = false;
      }
    } catch (_) {
      switchingSource = false;
      resetPlayback();
    }
    return true;
  }

  if (item.poster) {
    const posterProbe = new Image();
    let fallbackPoster = item.fallbackPoster || "";
    posterProbe.decoding = "async";
    posterProbe.addEventListener(
      "load",
      () => {
        hasPreviewFrame = true;
        if (video.paused && !video.hasAttribute("controls")) {
          status.hidden = true;
        }
      },
      { once: true },
    );
    posterProbe.addEventListener(
      "error",
      () => {
        if (fallbackPoster) {
          const nextPoster = fallbackPoster;
          fallbackPoster = "";
          video.poster = nextPoster;
          status.textContent = "正在切换 Pages 备用封面";
          posterProbe.src = nextPoster;
          return;
        }
        if (video.paused && !video.hasAttribute("controls")) {
          status.textContent = `点按播放 · ${getMediaSourceNote(source)}`;
        }
      },
    );
    posterProbe.src = item.poster;
  } else {
    status.textContent = `点按播放 · ${getMediaSourceNote(source)}`;
  }

  playButton.addEventListener("pointerenter", () => {
    videoLoadController.warmForIntent(video, false);
  });
  playButton.addEventListener(
    "pointerdown",
    () => {
      videoLoadController.warmForIntent(video, true);
    },
    { passive: true },
  );
  playButton.addEventListener("focus", () => {
    videoLoadController.warmForIntent(video, false);
  });

  playButton.addEventListener("click", () => {
    playbackRequested = true;
    pauseOtherVideos(video);
    playButton.hidden = true;
    expandButton.hidden = true;
    status.dataset.state = "loading";
    status.textContent = `加载中 · ${getMediaSourceNote(source)}`;
    status.hidden = false;

    videoLoadController.activate(video);

    try {
      const playback = video.play();
      if (playback) playback.catch(resetPlayback);
    } catch (_) {
      resetPlayback();
    }
  });
  video.addEventListener("play", () => {
    playbackRequested = true;
    claimMediaPlayback(video, {
      pause: resetPlayback,
      observeVisibility: true,
    });
  });
  video.addEventListener("playing", () => {
    switchingSource = false;
    hasPreviewFrame = true;
    status.hidden = true;
    video.controls = true;
    playButton.hidden = true;
    expandButton.hidden = true;
  });
  video.addEventListener("pause", () => {
    if (switchingSource) return;
    if (!video.error) playbackRequested = false;
    releaseMediaPlayback(video);
    videoLoadController.deactivate(video);
    const hiddenByFilter = video.closest(".staff-item")?.hidden;
    if (hiddenByFilter && video.currentTime > 0 && !video.ended) {
      showPreviewControls("continue");
    } else if (!video.hasAttribute("controls") && !video.ended) {
      showPreviewControls(previewAction);
    }
  });
  video.addEventListener("ended", () => {
    playbackRequested = false;
    releaseMediaPlayback(video);
    videoLoadController.deactivate(video);
    showPreviewControls("replay");
  });
  video.addEventListener("loadeddata", () => {
    hasPreviewFrame = true;
    if (video.paused) status.hidden = true;
  });
  video.addEventListener("error", () => {
    if (switchToFallbackSource()) return;

    playbackRequested = false;
    switchingSource = false;
    releaseMediaPlayback(video);
    videoLoadController.deactivate(video);
    video.pause();
    video.removeAttribute("controls");
    video.removeAttribute("src");
    video.dataset.preloadMode = "none";
    playButton.hidden = false;
    expandButton.hidden = false;
    setPreviewAction("play");
    status.hidden = false;
    status.dataset.state = "error";
    status.textContent = source === "local"
      ? "点按重试 · 本站视频加载失败"
      : "点按重试 · X 视频尚未连接";

    // 清除失败的媒体选择，下一次明确点按时可以重新发起请求。
    try {
      video.load();
    } catch (_) {}
  });
  expandButton.addEventListener("click", () => {
    openLightbox(index, expandButton);
  });

  mosaicItem.append(video, playButton, expandButton, status);
  return { element: mosaicItem, video, reset: resetPlayback };
}

/**
 * 创建画廊底部的作者、解析状态和原推文入口。
 *
 * @param {import("../types.js").TweetReference} tweet - 当前推文链接信息。
 * @param {import("../types.js").DynamicMedia} data - 已校验媒体数据。
 * @param {boolean} requestedTypeMatches - 深链接是否匹配真实素材。
 * @returns {HTMLDivElement} 画廊来源栏。
 */
function createGallerySource(tweet, data, requestedTypeMatches) {
  const source = document.createElement("div");
  source.className = "gallery-source";
  const sourceCopy = document.createElement("span");
  const authorName = document.createElement("strong");
  authorName.textContent = data.author.name;
  sourceCopy.append(
    authorName,
    " @" +
      data.author.handle +
      " · 动态解析 " +
      data.items.length +
      " 个素材 · X 式拼图预览",
  );
  if (requestedTypeMatches) {
    sourceCopy.append(
      " · 已定位 " + tweet.mediaType + "/" + tweet.mediaIndex,
    );
  }

  const sourceLink = document.createElement("a");
  sourceLink.href = tweet.deepLink || tweet.url;
  sourceLink.target = "_blank";
  sourceLink.rel = "noreferrer";
  sourceLink.textContent = "在 X 查看原推文 ↗";
  source.append(sourceCopy, sourceLink);
  return source;
}

/**
 * 创建可直接播放视频、并能进入页面级完整预览的多素材画廊。
 *
 * @param {import("../types.js").TweetReference | null} tweet - X 素材的推文深链接；本站素材为 null。
 * @param {import("../types.js").DynamicMedia} data - 已校验的媒体数据。
 * @returns {HTMLElement} X 式拼图、站内视频播放和页面级媒体轮播。
 */
export function createMediaGallery(tweet, data) {
  const gallery = document.createElement("article");
  gallery.className = "media-gallery";
  gallery.setAttribute(
    "aria-label",
    data.author.name +
      " 的媒体画廊，共 " +
      data.items.length +
      " 个素材",
  );

  const mosaicItems = data.items.slice(0, 4);
  const mosaic = document.createElement("div");
  mosaic.className =
    "gallery-mosaic gallery-mosaic--" + mosaicItems.length;
  mosaic.setAttribute(
    "aria-label",
    data.author.name + " 的多素材拼图",
  );

  const initialMedia = resolveInitialMedia(tweet, data);
  const mosaicVideoPlayers = [];
  const videoLoadController = createMosaicVideoLoadController();
  galleryVideoLoadControllers.set(gallery, videoLoadController);
  const pauseMosaicVideos = () => {
    pauseActiveMediaPlayback("lightbox-open");
    mosaicVideoPlayers.forEach((player) => player.reset());
  };
  const lightbox = createMediaLightbox(
    data,
    initialMedia.index,
    pauseMosaicVideos,
    tweet,
  );

  data.items.forEach((item, index) => {
    if (index >= mosaicItems.length) return;

    let mosaicItem;
    if (item.type === "photo") {
      mosaicItem = createMosaicPhoto(
        item,
        index,
        data.source,
        lightbox.open,
      );
    } else {
      const videoResult = createMosaicVideo(
        item,
        index,
        data.author,
        data.source,
        videoLoadController,
        (activeVideo) => {
          mosaicVideoPlayers.forEach((player) => {
            if (player.video !== activeVideo) player.reset();
          });
        },
        lightbox.open,
      );
      mosaicItem = videoResult.element;
      mosaicVideoPlayers.push(videoResult);
      videoLoadController.register(videoResult.video);
    }

    if (initialMedia.matches && index === initialMedia.index) {
      mosaicItem.dataset.requested = "true";
    }
    if (
      index === mosaicItems.length - 1 &&
      data.items.length > mosaicItems.length
    ) {
      const overflowCopy = document.createElement("span");
      overflowCopy.className = "gallery-mosaic-overflow";
      overflowCopy.textContent =
        "+" + (data.items.length - mosaicItems.length);
      mosaicItem.appendChild(overflowCopy);
    }
    mosaic.appendChild(mosaicItem);
  });

  gallery.appendChild(mosaic);
  if (tweet) {
    gallery.appendChild(
      createGallerySource(tweet, data, initialMedia.matches),
    );
  }
  gallery.appendChild(lightbox.element);
  return gallery;
}

/**
 * 分阶段预热一个画廊中的列表视频。
 *
 * @description metadata 阶段只连接所有视频并读取基础信息；auto 阶段仅提升
 * 第一段视频，避免四宫格一次下载多段内容。用户明确指向其他播放按钮时，按钮
 * 自身会把对应视频提升到 auto。
 *
 * @param {HTMLElement} gallery - 已挂载的媒体画廊。
 * @param {"metadata" | "auto"} preloadMode - 本轮预热等级。
 * @returns {void}
 */
export function preloadMediaGalleryVideos(gallery, preloadMode) {
  const videos = Array.from(
    gallery.querySelectorAll("video.gallery-mosaic-video"),
  );
  if (preloadMode === "auto") {
    const controller = galleryVideoLoadControllers.get(gallery);
    if (controller) {
      controller.warmFirst();
    } else {
      const firstVideo = videos[0];
      if (firstVideo) attachMosaicVideoSource(firstVideo, "auto");
    }
    return;
  }

  videos.forEach((video) => {
    attachMosaicVideoSource(video, "metadata");
  });
}
