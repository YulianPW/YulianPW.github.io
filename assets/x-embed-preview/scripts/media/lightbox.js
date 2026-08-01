/**
 * 创建灯箱中的一个完整比例媒体页。
 *
 * @param {import("../types.js").MediaItem} item - 当前媒体。
 * @param {number} index - 当前媒体索引。
 * @param {import("../types.js").DynamicMedia} data - 完整媒体数据。
 * @param {number} initialIndex - 初次打开时的目标索引。
 * @param {import("../types.js").TweetReference | null} tweet - X 素材的原推文；本站素材为 null。
 * @returns {HTMLDivElement} 可放入灯箱舞台的媒体页。
 */
function createLightboxSlide(item, index, data, initialIndex, tweet) {
  const typeLabel = item.type === "photo" ? "图片" : "视频";
  const slide = document.createElement("div");
  slide.className = "gallery-lightbox-slide";
  slide.hidden = true;
  slide.setAttribute(
    "aria-label",
    "第 " + (index + 1) + " 个素材：" + typeLabel,
  );

  const media = document.createElement(
    item.type === "photo" ? "img" : "video",
  );
  media.className = "gallery-lightbox-media";
  if (item.type === "photo") {
    media.alt =
      item.alt || data.author.name + " 的第 " + (index + 1) + " 张图片";
    media.loading = index === initialIndex ? "eager" : "lazy";
    media.decoding = "async";
  } else {
    media.controls = true;
    media.playsInline = true;
    media.preload = "metadata";
    if (item.poster) media.poster = item.poster;
    media.setAttribute(
      "aria-label",
      data.author.name + " 的第 " + (index + 1) + " 段放大视频",
    );
  }

  const mediaError = document.createElement("div");
  mediaError.className = "gallery-lightbox-error";
  mediaError.hidden = true;
  const errorCopy = document.createElement("span");
  errorCopy.textContent = data.source === "local"
    ? "本站素材加载失败，请稍后重试。"
    : "X 媒体未加载，请确认已开🪜。";
  mediaError.appendChild(errorCopy);
  if (tweet) {
    const sourceLink = document.createElement("a");
    sourceLink.href = tweet.deepLink || tweet.url;
    sourceLink.target = "_blank";
    sourceLink.rel = "noreferrer";
    sourceLink.textContent = "打开原推文 ↗";
    mediaError.appendChild(sourceLink);
  }
  media.addEventListener("error", () => {
    media.hidden = true;
    mediaError.hidden = false;
  });
  media.dataset.src = item.url;

  slide.append(media, mediaError);
  return slide;
}

/**
 * 创建页面级媒体灯箱及其打开控制器。
 *
 * @description 灯箱负责完整比例展示、键盘导航、移动端滑动、视频暂停和焦点恢复。
 * 拼图组件只需调用返回的 open 方法，无需了解 dialog 内部结构。
 *
 * @param {import("../types.js").DynamicMedia} data - 已校验的媒体数据。
 * @param {number} initialIndex - 深链接对应的初始素材索引。
 * @param {() => void} onBeforeOpen - 打开前用于暂停拼图视频的回调。
 * @param {import("../types.js").TweetReference | null} tweet - X 素材的原推文；本站素材为 null。
 * @returns {{element: HTMLDialogElement, open: (index: number, trigger: HTMLElement) => void}}
 * 灯箱节点及其打开方法。
 */
export function createMediaLightbox(data, initialIndex, onBeforeOpen, tweet) {
  const lightbox = document.createElement("dialog");
  lightbox.className = "gallery-lightbox";
  lightbox.setAttribute(
    "aria-label",
    data.author.name + " 的媒体放大预览",
  );

  const shell = document.createElement("div");
  shell.className = "gallery-lightbox-shell";
  const stage = document.createElement("div");
  stage.className = "gallery-lightbox-stage";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "gallery-lightbox-close";
  closeButton.setAttribute("aria-label", "关闭放大预览");
  closeButton.textContent = "×";

  const indexCopy = document.createElement("span");
  indexCopy.className = "gallery-lightbox-index";
  indexCopy.setAttribute("aria-live", "polite");

  const previousButton = document.createElement("button");
  previousButton.type = "button";
  previousButton.className =
    "gallery-lightbox-nav gallery-lightbox-nav--previous";
  previousButton.setAttribute("aria-label", "上一个素材");
  previousButton.textContent = "‹";

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className =
    "gallery-lightbox-nav gallery-lightbox-nav--next";
  nextButton.setAttribute("aria-label", "下一个素材");
  nextButton.textContent = "›";

  const slides = data.items.map((item, index) =>
    createLightboxSlide(item, index, data, initialIndex, tweet),
  );
  stage.append(...slides);
  shell.append(
    stage,
    closeButton,
    indexCopy,
    previousButton,
    nextButton,
  );
  lightbox.appendChild(shell);

  let activeIndex = initialIndex;
  let lightboxTrigger = null;
  let touchStartX = null;

  /**
   * 首次显示某个灯箱页时才连接对应的高清媒体地址。
   *
   * @param {number} index - 要加载的素材索引。
   * @returns {void}
   */
  function ensureSlideMediaLoaded(index) {
    const media = slides[index]?.querySelector(".gallery-lightbox-media");
    const source = media?.dataset.src;
    if (!media || !source) return;
    media.src = source;
    delete media.dataset.src;
  }

  /**
   * 切换当前素材，并暂停刚离开的原生视频。
   *
   * @param {number} nextIndex - 下一项在媒体清单中的索引。
   * @returns {void}
   */
  function showSlide(nextIndex) {
    if (nextIndex < 0 || nextIndex >= data.items.length) return;

    const previousVideo = slides[activeIndex]?.querySelector("video");
    if (previousVideo && nextIndex !== activeIndex) previousVideo.pause();

    slides.forEach((slide, index) => {
      slide.hidden = index !== nextIndex;
    });
    activeIndex = nextIndex;

    const activeItem = data.items[activeIndex];
    const typeLabel = activeItem.type === "photo" ? "图片" : "视频";
    indexCopy.textContent =
      activeIndex + 1 + " / " + data.items.length + " · " + typeLabel;
    previousButton.disabled = activeIndex === 0;
    nextButton.disabled = activeIndex === data.items.length - 1;
    if (lightbox.open) ensureSlideMediaLoaded(activeIndex);
  }

  /**
   * 从拼图打开页面级轮播。
   *
   * @param {number} index - 要放大的素材索引。
   * @param {HTMLElement} trigger - 关闭后需要恢复焦点的入口。
   * @returns {void}
   */
  function open(index, trigger) {
    onBeforeOpen();
    lightboxTrigger = trigger;
    showSlide(index);
    if (!lightbox.open) {
      document.body.classList.add("gallery-lightbox-open");
      lightbox.showModal();
    }
    ensureSlideMediaLoaded(activeIndex);
  }

  closeButton.addEventListener("click", () => {
    if (lightbox.open) lightbox.close();
  });
  previousButton.addEventListener("click", () => {
    showSlide(activeIndex - 1);
  });
  nextButton.addEventListener("click", () => {
    showSlide(activeIndex + 1);
  });
  lightbox.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLMediaElement) return;
    if (event.key === "ArrowLeft") {
      showSlide(activeIndex - 1);
    } else if (event.key === "ArrowRight") {
      showSlide(activeIndex + 1);
    }
  });
  lightbox.addEventListener("close", () => {
    const activeVideo = slides[activeIndex]?.querySelector("video");
    if (activeVideo) activeVideo.pause();
    document.body.classList.remove("gallery-lightbox-open");
    if (lightboxTrigger?.isConnected) lightboxTrigger.focus();
    lightboxTrigger = null;
  });
  stage.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length === 1) {
        touchStartX = event.touches[0].clientX;
      }
    },
    { passive: true },
  );
  stage.addEventListener(
    "touchend",
    (event) => {
      const eventTarget = event.target;
      if (
        touchStartX === null ||
        event.changedTouches.length === 0 ||
        (eventTarget instanceof Element && eventTarget.closest("video"))
      ) {
        touchStartX = null;
        return;
      }

      const deltaX = event.changedTouches[0].clientX - touchStartX;
      touchStartX = null;
      if (Math.abs(deltaX) < 52) return;
      showSlide(activeIndex + (deltaX < 0 ? 1 : -1));
    },
    { passive: true },
  );
  stage.addEventListener("touchcancel", () => {
    touchStartX = null;
  });

  showSlide(initialIndex);
  return { element: lightbox, open };
}
