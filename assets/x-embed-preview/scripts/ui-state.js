/**
 * 更新顶部加载轨道中的单项状态。
 *
 * @param {string} elementId - 轨道节点 ID。
 * @param {"loading" | "ready" | "dormant" | "error"} state - 当前状态。
 * @param {string} label - 展示给用户的状态文案。
 * @returns {void}
 */
export function setRailState(elementId, state, label) {
  const rail = document.getElementById(elementId);
  rail.dataset.state = state;
  rail.querySelector("span").textContent = label;
}

/**
 * 创建组件加载占位。
 *
 * @param {string} label - 当前加载动作。
 * @returns {HTMLDivElement} 加载状态节点。
 */
export function createLoadingState(label) {
  const state = document.createElement("div");
  state.className = "loading-state";
  const text = document.createElement("span");
  text.textContent = label;
  state.appendChild(text);
  return state;
}

/**
 * 在组件不可用时显示明确的降级入口。
 *
 * @param {HTMLElement} container - 状态容器。
 * @param {Pick<import("./types.js").TweetReference, "url">} tweet - 当前推文。
 * @param {string} message - 失败原因说明。
 * @returns {void}
 */
export function renderWidgetError(container, tweet, message) {
  const state = document.createElement("div");
  state.className = "error-state";
  const text = document.createElement("span");
  text.append(message + " ");
  const link = document.createElement("a");
  link.href = tweet.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "直接在 X 查看";
  text.appendChild(link);
  state.appendChild(text);
  container.replaceChildren(state);
}
