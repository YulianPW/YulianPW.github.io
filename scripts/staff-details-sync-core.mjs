import {
  SNAPSHOT_SCHEMA_VERSION,
  canonicalJson,
  canonicalSha256,
  equalStaffDetails,
  normalizeStaffDetails,
  requireDetailsRevision,
  requireStaffId,
} from "./staff-details-contract.mjs";

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
 * @param {unknown} localData - 本地 `data.json` 解析结果。
 * @param {ReturnType<typeof normalizeStaffDetailsSnapshot>} snapshot - 已验证完整快照。
 * @returns {{data: Record<string, unknown>, changedStaffIds: string[]}} 合并结果与变化 ID。
 * @throws {Error} ID 集不一致、revision 回退或同 revision 异文时抛出。
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
    localById.set(staffId, { staff, detailsRevision, details });
  });

  const remoteById = new Map(
    snapshot.profiles.map((profile) => [profile.staffId, profile]),
  );
  const missingIds = [...localById.keys()].filter((id) => !remoteById.has(id));
  const extraIds = [...remoteById.keys()].filter((id) => !localById.has(id));
  if (missingIds.length || extraIds.length) {
    throw new Error(
      `staffId 集合不一致；远端缺失=${formatIds(missingIds)}；远端额外=${formatIds(extraIds)}`,
    );
  }

  const changedStaffIds = [];
  const mergedStaff = localData.staff.map((staff) => {
    const local = localById.get(staff.staffId);
    const remote = remoteById.get(staff.staffId);
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
    changedStaffIds,
  };
}

/**
 * 核对已合并站点数据与远端完整快照的 revision 和正文。
 *
 * @param {unknown} data - 合并后的站点数据。
 * @param {ReturnType<typeof normalizeStaffDetailsSnapshot>} snapshot - 已验证快照。
 * @returns {void}
 * @throws {Error} 任一受托管字段没有精确收敛时抛出。
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
