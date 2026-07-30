import { LOCAL_COVER_BY_TWEET_ID } from "./config.js";

/**
 * 从站内条目整理轻量卡片所需字段。
 *
 * @param {import("./types.js").TweetReference} tweet - 当前推文。
 * @param {object | null} repositoryItem - 可选的站内数据条目。
 * @returns {import("./types.js").LocalCardData} 卡片展示数据。
 */
export function getLocalCardData(tweet, repositoryItem) {
  const card = repositoryItem?.tweetCard || {};
  const handle = card.handle || tweet.handle || "x";
  const localCover = LOCAL_COVER_BY_TWEET_ID[tweet.id] || "";
  return {
    name: card.name || repositoryItem?.name || "@" + handle,
    handle,
    avatar: "",
    text:
      card.text ||
      "这条推文尚未保存本地文案；入库后可在列表中显示一句简介。",
    cover: localCover,
    hasLocalData: Boolean(repositoryItem && localCover),
  };
}

/**
 * 创建一张不依赖 X 组件的轻量卡片。
 *
 * @param {import("./types.js").TweetReference} tweet - 当前推文。
 * @param {import("./types.js").LocalCardData} data - 卡片展示数据。
 * @param {"link" | "expand"} actionType - 点击跳转或按需展开。
 * @param {(() => Promise<boolean | null>) | null} onExpand - 按需展开回调；过期渲染返回 null。
 * @returns {HTMLElement} 完整卡片节点。
 */
export function createLocalCard(
  tweet,
  data,
  actionType,
  onExpand = null,
) {
  const card = document.createElement("article");
  card.className = data.hasLocalData
    ? "local-card has-cover"
    : "local-card";

  const coverFrame = document.createElement("div");
  coverFrame.className = "cover-frame";
  const placeholder = document.createElement("div");
  placeholder.className = "cover-placeholder";
  placeholder.hidden = Boolean(data.cover);
  const placeholderCopy = document.createElement("div");
  const placeholderMark = document.createElement("strong");
  placeholderMark.textContent = "X";
  const placeholderText = document.createElement("span");
  placeholderText.textContent = "封面待保存到站内";
  placeholderCopy.append(placeholderMark, placeholderText);
  placeholder.appendChild(placeholderCopy);

  const coverImage = document.createElement("img");
  coverImage.className = "cover-image";
  coverImage.alt = data.hasLocalData
    ? data.name + " 的视频封面"
    : "推文封面待入库";
  coverImage.loading = "lazy";
  coverImage.decoding = "async";
  coverImage.hidden = !data.cover;
  if (data.cover) coverImage.src = data.cover;
  coverImage.addEventListener("error", () => {
    coverImage.hidden = true;
    placeholder.hidden = false;
  });

  const coverLabel = document.createElement("span");
  coverLabel.className = "cover-label";
  coverLabel.textContent = data.hasLocalData
    ? "站内已有封面"
    : "结构预览";
  const playMark = document.createElement("span");
  playMark.className = "play-mark";
  playMark.setAttribute("aria-hidden", "true");
  coverFrame.append(placeholder, coverImage, coverLabel, playMark);

  const cardBody = document.createElement("div");
  cardBody.className = "card-body";
  const authorLine = document.createElement("div");
  authorLine.className = "author-line";
  let avatar;
  if (data.avatar) {
    avatar = document.createElement("img");
    avatar.className = "author-avatar";
    avatar.src = data.avatar;
    avatar.alt = "";
    avatar.loading = "lazy";
    avatar.addEventListener("error", () => {
      avatar.hidden = true;
    });
  } else {
    avatar = document.createElement("span");
    avatar.className = "author-monogram";
    avatar.textContent = data.name.slice(0, 1).toUpperCase();
    avatar.setAttribute("aria-hidden", "true");
  }

  const authorCopy = document.createElement("div");
  authorCopy.className = "author-copy";
  const authorName = document.createElement("strong");
  authorName.className = "author-name";
  authorName.textContent = data.name;
  const authorHandle = document.createElement("span");
  authorHandle.className = "author-handle";
  authorHandle.textContent = "@" + data.handle;
  authorCopy.append(authorName, authorHandle);
  authorLine.append(avatar, authorCopy);

  const cardText = document.createElement("p");
  cardText.className = "card-text";
  cardText.textContent = data.text;

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const note = document.createElement("span");
  note.className = "card-note";
  note.textContent = "0 个 X 组件";
  let action;
  if (actionType === "expand") {
    action = document.createElement("button");
    action.type = "button";
    action.className = "card-action";
    action.textContent = "展开完整推文";
    action.addEventListener("click", async () => {
      action.disabled = true;
      action.textContent = "正在展开…";
      const isReady = await onExpand();
      if (isReady === null) return;
      action.textContent = isReady ? "已展开" : "重新展开";
      action.disabled = isReady;
    });
  } else {
    action = document.createElement("a");
    action.className = "card-action";
    action.href = tweet.url;
    action.target = "_blank";
    action.rel = "noreferrer";
    action.textContent = "在 X 打开";
  }

  actions.append(note, action);
  cardBody.append(authorLine, cardText, actions);
  card.append(coverFrame, cardBody);
  return card;
}
