import {
  LOCAL_DETAILS_REVISION,
  SNAPSHOT_SCHEMA_VERSION,
  canonicalJson,
  canonicalSha256,
  equalStaffDetails,
  normalizeStaffDetails,
  requireDetailsRevision,
  requireStaffId,
} from "./staff-details-contract.mjs";
import { validateStaffData } from "./validate-staff-data.mjs";

const SNAPSHOT_KEYS = new Set([
  "schemaVersion",
  "snapshotVersion",
  "generatedAt",
  "coverage",
  "profiles",
]);
const PROFILE_KEYS = new Set([
  "staffId",
  "revision",
  "updatedAt",
  "details",
]);
const SNAPSHOT_VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * 严格校验并规范化云端完整公开快照。
 *
 * @param {unknown} value - API 返回的 JSON 候选值。
 * @returns {{schemaVersion: number, snapshotVersion: string, generatedAt: string, coverage: string, profiles: Array<Record<string, unknown>>}} 规范快照。
 * @throws {Error} schema、集合、时间、正文或内容哈希无效时抛出。
 */
export function normalizeStaffDetailsSnapshot(value) {
  if (!isPlainObject(value)) {
    throw new Error("快照顶层必须是对象");
  }
  assertExactKeys(value, SNAPSHOT_KEYS, "snapshot");
  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`不支持的 schemaVersion：${String(value.schemaVersion)}`);
  }
  if (value.coverage !== "full") {
    throw new Error("快照 coverage 必须为 full");
  }
  if (
    typeof value.snapshotVersion !== "string" ||
    !SNAPSHOT_VERSION_PATTERN.test(value.snapshotVersion)
  ) {
    throw new Error("snapshotVersion 必须是 sha256 内容摘要");
  }
  const generatedAt = requireUtcTimestamp(value.generatedAt, "generatedAt");
  if (!Array.isArray(value.profiles)) {
    throw new Error("profiles 必须是数组");
  }

  const staffIds = new Set();
  let previousStaffId = null;
  const profiles = value.profiles.map((profile, index) => {
    const profilePath = `profiles[${index}]`;
    if (!isPlainObject(profile)) {
      throw new Error(`${profilePath} 必须是对象`);
    }
    assertExactKeys(profile, PROFILE_KEYS, profilePath);
    const staffId = requireStaffId(profile.staffId, `${profilePath}.staffId`);
    const revision = requireDetailsRevision(
      profile.revision,
      `${profilePath}.revision`,
    );
    if (revision < 1) {
      throw new Error(`${profilePath}.revision 必须从 1 开始`);
    }
    if (staffIds.has(staffId)) {
      throw new Error(`${profilePath}.staffId 重复：${staffId}`);
    }
    if (previousStaffId !== null && staffId <= previousStaffId) {
      throw new Error("profiles 必须按 staffId 严格升序排列");
    }
    staffIds.add(staffId);
    previousStaffId = staffId;
    return {
      staffId,
      revision,
      updatedAt: requireUtcTimestamp(
        profile.updatedAt,
        `${profilePath}.updatedAt`,
      ),
      details: normalizeStaffDetails(profile.details, `${profilePath}.details`),
    };
  });

  const expectedVersion = canonicalSha256({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    coverage: "full",
    profiles,
  });
  if (value.snapshotVersion !== expectedVersion) {
    throw new Error(
      `snapshotVersion 与正文不匹配：期望 ${expectedVersion}，收到 ${value.snapshotVersion}`,
    );
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotVersion: value.snapshotVersion,
    generatedAt,
    coverage: "full",
    profiles,
  };
}

/**
 * 把已验证云端快照合并到站点读模型，只替换受托管字段。
 *
 * @description `detailsRevision: 0` 的固定本地资料始终保持原样；其余资料
 * 只按 `staffId` 同步本地与云端的交集。云端独有记录不会新增到本地，
 * 本地独有记录也不会被删除或改写。
 *
 * @param {unknown} localData - 本地 `data.json` 解析结果。
 * @param {ReturnType<typeof normalizeStaffDetailsSnapshot>} snapshot - 已验证完整快照。
 * @returns {{data: Record<string, unknown>, changedStaffIds: string[], remoteOnlyStaffIds: string[], localMissingRemoteStaffIds: string[]}} 合并结果与差异 ID。
 * @throws {Error} 交集记录 revision 回退或同 revision 异文时抛出。
 */
export function mergeStaffDetails(localData, snapshot) {
  if (!isPlainObject(localData) || !Array.isArray(localData.staff)) {
    throw new Error("本地 data.json.staff 必须是数组");
  }

  const localById = new Map();
  localData.staff.forEach((staff, index) => {
    const path = `staff[${index}]`;
    if (!isPlainObject(staff)) {
      throw new Error(`${path} 必须是对象`);
    }
    const staffId = requireStaffId(staff.staffId, `${path}.staffId`);
    if (localById.has(staffId)) {
      throw new Error(`${path}.staffId 重复：${staffId}`);
    }
    const detailsRevision = requireDetailsRevision(
      staff.detailsRevision,
      `${path}.detailsRevision`,
    );
    const details = normalizeStaffDetails(staff.details, `${path}.details`);
    const local = { staff, detailsRevision, details };
    localById.set(staffId, local);
  });

  const remoteById = new Map(
    snapshot.profiles.map((profile) => [profile.staffId, profile]),
  );
  const remoteOnlyStaffIds = snapshot.profiles
    .filter((profile) => !localById.has(profile.staffId))
    .map((profile) => profile.staffId);
  const localMissingRemoteStaffIds = [...localById.entries()]
    .filter(
      ([staffId, local]) =>
        local.detailsRevision !== LOCAL_DETAILS_REVISION && !remoteById.has(staffId),
    )
    .map(([staffId]) => staffId)
    .sort();
  const changedStaffIds = [];
  const mergedStaff = localData.staff.map((staff) => {
    const local = localById.get(staff.staffId);
    if (local.detailsRevision === LOCAL_DETAILS_REVISION) {
      return staff;
    }
    const remote = remoteById.get(staff.staffId);
    if (!remote) {
      return staff;
    }
    if (remote.revision < local.detailsRevision) {
      throw new Error(
        `${staff.staffId} 远端 revision ${remote.revision} 早于本地 ${local.detailsRevision}`,
      );
    }
    if (remote.revision === local.detailsRevision) {
      if (!equalStaffDetails(remote.details, local.details)) {
        throw new Error(`${staff.staffId} 同 revision 正文不一致`);
      }
      return staff;
    }

    changedStaffIds.push(staff.staffId);
    const merged = {
      ...staff,
      detailsRevision: remote.revision,
      details: remote.details,
    };
    assertUnmanagedFieldsUnchanged(staff, merged);
    return merged;
  });

  return {
    data: { ...localData, staff: mergedStaff },
    changedStaffIds: changedStaffIds.sort(),
    remoteOnlyStaffIds,
    localMissingRemoteStaffIds,
  };
}

/**
 * 使用同一份已验证快照，把指定云端资料首次接入站点数组末尾。
 *
 * @param {unknown} localData - 已完成常规合并的站点数据。
 * @param {ReturnType<typeof normalizeStaffDetailsSnapshot>} snapshot - 已验证完整快照。
 * @param {{staffId: string, name: string, tags: string, social: string, mediaFolder?: string}} input - 站点本地展示字段。
 * @returns {{data: Record<string, unknown>, addedStaffIds: string[]}} 追加后的站点数据。
 * @throws {Error} staffId 已存在、快照中不存在，或站点字段不符合现有 schema 时抛出。
 */
export function appendStaffFromSnapshot(localData, snapshot, input) {
  if (!isPlainObject(localData) || !Array.isArray(localData.staff)) {
    throw new Error("本地 data.json.staff 必须是数组");
  }
  const staffId = requireStaffId(input.staffId, "--add-staff");
  if (localData.staff.some((staff) => staff.staffId === staffId)) {
    throw new Error(`staffId 已存在，拒绝覆盖：${staffId}`);
  }
  const profile = snapshot.profiles.find((item) => item.staffId === staffId);
  if (!profile) {
    throw new Error(`云端快照中不存在 staffId：${staffId}`);
  }

  const newStaff = {
    tags: input.tags,
    staffId,
    detailsRevision: profile.revision,
    name: input.name,
    social: input.social,
    ...(input.mediaFolder === undefined
      ? {}
      : { mediaFolder: input.mediaFolder }),
    details: profile.details,
  };
  const data = { ...localData, staff: [...localData.staff, newStaff] };
  validateStaffData(data);
  return { data, addedStaffIds: [staffId] };
}

/**
 * 核对已合并站点数据与远端快照交集的 revision 和正文。
 *
 * @param {unknown} data - 合并后的站点数据。
 * @param {ReturnType<typeof normalizeStaffDetailsSnapshot>} snapshot - 已验证快照。
 * @returns {void}
 * @throws {Error} 任一交集记录的受托管字段没有精确收敛时抛出。
 */
export function verifyMergedStaffDetails(data, snapshot) {
  const result = mergeStaffDetails(data, snapshot);
  if (result.changedStaffIds.length) {
    throw new Error(
      `写入后仍有未应用资料：${formatIds(result.changedStaffIds)}`,
    );
  }
}

function assertUnmanagedFieldsUnchanged(before, after) {
  const omitManaged = (item) =>
    Object.fromEntries(
      Object.entries(item).filter(
        ([key]) => key !== "details" && key !== "detailsRevision",
      ),
    );
  if (canonicalJson(omitManaged(before)) !== canonicalJson(omitManaged(after))) {
    throw new Error(`${before.staffId} 的非托管字段发生变化`);
  }
}

function requireUtcTimestamp(value, fieldPath) {
  if (
    typeof value !== "string" ||
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${fieldPath} 必须是 UTC RFC 3339 时间`);
  }
  return value;
}

function assertExactKeys(value, allowedKeys, fieldPath) {
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !allowedKeys.has(key));
  const missing = [...allowedKeys].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    throw new Error(
      `${fieldPath} 字段不完整；缺失=${missing.join(",") || "无"}；未知=${unknown.join(",") || "无"}`,
    );
  }
}

function formatIds(ids) {
  return ids.length ? ids.sort().join(",") : "无";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
