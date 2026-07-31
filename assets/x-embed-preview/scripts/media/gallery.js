import { createMediaLightbox } from "./lightbox.js?v=2026073103";

/**
 * 解析媒体深链接在画廊中的初始位置。
 *
 * @param {import("../types.js").TweetReference} tweet - 当前推文链接信息。
 * @param {import("../types.js").DynamicMedia} data - 已校验媒体数据。
 * @returns {{index: number, matches: boolean}} 初始索引及深链接是否有效。
 */
function resolveInitialMedia(tweet, data) {
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
 * 创建点击后进入灯箱的拼图图片。
 *
 * @param {import("../types.js").MediaItem} item - 图片素材。
 * @param {number} index - 素材索引。
 * @param {(index: number, trigger: HTMLElement) => void} openLightbox - 灯箱入口。
 * @returns {HTMLButtonElement} 拼图图片按钮。
 */
function createMosaicPhoto(item, index, openLightbox) {
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
  status.textContent = "来源 X · 需开🪜";
  image.addEventListener("load", () => {
    image.classList.add("is-loaded");
    status.hidden = true;
  });
  image.addEventListener("error", () => {
    image.hidden = true;
    status.hidden = false;
    status.dataset.state = "error";
    status.textContent = "X 媒体未加载 · 请确认已开🪜";
  });
  image.src = item.url;

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
 * @param {(activeVideo: HTMLVideoElement) => void} pauseOtherVideos - 播放前暂停其他视频。
 * @param {(index: number, trigger: HTMLElement) => void} openLightbox - 灯箱入口。
 * @returns {{element: HTMLDivElement, video: HTMLVideoElement}} 拼图节点及播放器。
 */
function createMosaicVideo(
  item,
  index,
  author,
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
  video.preload = "metadata";
  if (item.poster) video.poster = item.poster;
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
  status.textContent = "来源 X · 需开🪜";

  playButton.addEventListener("click", () => {
    pauseOtherVideos(video);
    video.controls = true;
    const playback = video.play();
    if (playback) {
      playback.catch(() => {
        playButton.hidden = false;
      });
    }
  });
  video.addEventListener("play", () => {
    playButton.hidden = true;
  });
  video.addEventListener("ended", () => {
    playButton.hidden = false;
    playButton.setAttribute(
      "aria-label",
      "再次播放第 " + (index + 1) + " 段视频",
    );
  });
  video.addEventListener("loadedmetadata", () => {
    status.hidden = true;
  });
  video.addEventListener("error", () => {
    video.hidden = true;
    playButton.hidden = true;
    status.hidden = false;
    status.dataset.state = "error";
    status.textContent = "X 媒体未加载 · 请确认已开🪜";
  });
  expandButton.addEventListener("click", () => {
    openLightbox(index, expandButton);
  });
  video.src = item.url;

  mosaicItem.append(video, playButton, expandButton, status);
  return { element: mosaicItem, video };
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
 * @param {import("../types.js").TweetReference} tweet - 当前推文及媒体深链接。
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
    data.author.name + " 的 X 式多素材拼图",
  );

  const initialMedia = resolveInitialMedia(tweet, data);
  const mosaicVideos = [];
  const pauseMosaicVideos = () => {
    mosaicVideos.forEach((video) => video.pause());
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
      mosaicItem = createMosaicPhoto(item, index, lightbox.open);
    } else {
      const videoResult = createMosaicVideo(
        item,
        index,
        data.author,
        (activeVideo) => {
          mosaicVideos.forEach((video) => {
            if (video !== activeVideo) video.pause();
          });
        },
        lightbox.open,
      );
      mosaicItem = videoResult.element;
      mosaicVideos[index] = videoResult.video;
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

  gallery.append(
    mosaic,
    createGallerySource(tweet, data, initialMedia.matches),
    lightbox.element,
  );
  return gallery;
}
