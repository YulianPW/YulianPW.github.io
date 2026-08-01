const INLINE_VISIBLE_RATIO = 0.25;
const OFFSCREEN_PAUSE_DELAY_MS = 200;

/**
 * 播放协调器触发暂停的原因。
 *
 * @typedef {"replaced" | "offscreen" | "page-hidden" | "lightbox-open"} PlaybackPauseReason
 */

/**
 * @typedef {object} ActivePlayback
 * @property {HTMLMediaElement} media - 当前获得全站播放权的媒体节点。
 * @property {(reason: PlaybackPauseReason) => void} pause - 按组件语义暂停并刷新界面的回调。
 * @property {boolean} observeVisibility - 是否在内容离开视口时自动暂停。
 * @property {number} visibilityRatio - 最近一次观察到的可见面积比例。
 */

/** @type {ActivePlayback | null} */
let activePlayback = null;
let offscreenPauseTimer = null;

/**
 * 清除等待中的离屏暂停，避免用户快速回划后仍被旧任务打断。
 *
 * @returns {void}
 */
function clearOffscreenPauseTimer() {
  if (offscreenPauseTimer === null) return;
  window.clearTimeout(offscreenPauseTimer);
  offscreenPauseTimer = null;
}

/**
 * 暂停指定的当前播放项并释放全站播放权。
 *
 * @param {ActivePlayback} playback - 需要暂停的活跃播放项。
 * @param {PlaybackPauseReason} reason - 触发暂停的产品原因。
 * @returns {void}
 */
function pausePlayback(playback, reason) {
  if (activePlayback !== playback) return;

  activePlayback = null;
  clearOffscreenPauseTimer();
  activeMediaObserver?.unobserve(playback.media);
  playback.pause(reason);
}

/**
 * 在列表视频持续低于有效可见阈值时安排一次暂停。
 *
 * @param {ActivePlayback} playback - 当前列表视频播放项。
 * @returns {void}
 */
function scheduleOffscreenPause(playback) {
  if (offscreenPauseTimer !== null) return;

  offscreenPauseTimer = window.setTimeout(() => {
    offscreenPauseTimer = null;
    if (
      activePlayback !== playback ||
      playback.media.paused ||
      playback.visibilityRatio >= INLINE_VISIBLE_RATIO
    ) {
      return;
    }
    pausePlayback(playback, "offscreen");
  }, OFFSCREEN_PAUSE_DELAY_MS);
}

const activeMediaObserver = "IntersectionObserver" in window
  ? new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const playback = activePlayback;
          if (
            !playback?.observeVisibility ||
            playback.media !== entry.target
          ) {
            return;
          }

          playback.visibilityRatio = entry.intersectionRatio;
          if (entry.intersectionRatio >= INLINE_VISIBLE_RATIO) {
            clearOffscreenPauseTimer();
          } else {
            scheduleOffscreenPause(playback);
          }
        });
      },
      { threshold: [0, INLINE_VISIBLE_RATIO] },
    )
  : null;

/**
 * 让一个媒体节点获得全站唯一播放权。
 *
 * @description 新媒体开始播放前会暂停旧媒体。列表视频还会成为唯一的视口观察
 * 目标；灯箱视频只参与全局互斥和页面生命周期，不受列表可见比例规则影响。
 * 协调器只暂停且保留当前进度和缓冲，从不自动恢复播放。
 *
 * @param {HTMLMediaElement} media - 刚触发 play 事件的媒体节点。
 * @param {object} options - 当前组件的暂停行为和观察策略。
 * @param {(reason: PlaybackPauseReason) => void} options.pause - 暂停并同步组件界面的回调。
 * @param {boolean} [options.observeVisibility=false] - 是否启用列表离屏暂停。
 * @returns {void}
 */
export function claimMediaPlayback(
  media,
  { pause, observeVisibility = false },
) {
  if (activePlayback?.media === media) return;

  pauseActiveMediaPlayback("replaced");
  const playback = {
    media,
    pause,
    observeVisibility,
    visibilityRatio: 1,
  };
  activePlayback = playback;
  if (observeVisibility) activeMediaObserver?.observe(media);

  // 某些浏览器会在页面转入后台的同一事件循环内继续派发 play。
  if (document.hidden) pausePlayback(playback, "page-hidden");
}

/**
 * 在媒体自行暂停或播放结束后释放其全站播放权。
 *
 * @param {HTMLMediaElement} media - 已不再播放的媒体节点。
 * @returns {void}
 */
export function releaseMediaPlayback(media) {
  if (activePlayback?.media !== media) return;

  activeMediaObserver?.unobserve(media);
  activePlayback = null;
  clearOffscreenPauseTimer();
}

/**
 * 按指定原因暂停当前全站活跃媒体。
 *
 * @param {PlaybackPauseReason} reason - 触发暂停的产品原因。
 * @returns {void}
 */
export function pauseActiveMediaPlayback(reason) {
  const playback = activePlayback;
  if (playback) pausePlayback(playback, reason);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseActiveMediaPlayback("page-hidden");
});
window.addEventListener("pagehide", () => {
  pauseActiveMediaPlayback("page-hidden");
});
