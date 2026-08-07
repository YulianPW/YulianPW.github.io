import { createHash } from "node:crypto";

export const DETAILS_SCHEMA_VERSION = 1;
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

const DETAIL_LIMITS = Object.freeze({
  entry: 128,
  intro: 1000,
  afterEntry: 2000,
});
const MAX_DETAILS_BYTES = 32 * 1024;
const MAX_SERVICE_COUNT = 30;
const MAX_SERVICE_LABEL_LENGTH = 64;
const MAX_SERVICE_DETAIL_LENGTH = 512;
const MAX_SERVICE_ADD_ON_COUNT = 30;
const MAX_SERVICE_ADD_ON_ITEM_LENGTH = 128;
const DETAIL_KEYS = new Set(["entry", "intro", "services", "afterEntry"]);
const SERVICE_KEYS = new Set(["label", "detail", "addOns"]);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * 校验并规范化云端与站点共用的四块公开资料。
 *
 * @param {unknown} value - 外部 JSON 中的 details 候选值。
 * @param {string} [fieldPath="details"] - 用于错误信息的字段路径。
 * @returns {Record<string, unknown>} 省略空区块且保持服务顺序的规范对象。
 * @throws {Error} 字段未知、为空、超限或含不允许的控制字符时抛出。
 */
export function normalizeStaffDetails(value, fieldPath = "details") {
  if (!isPlainObject(value)) {
    throw new Error(`${fieldPath} 必须是对象`);
  }
  assertExactKeys(value, DETAIL_KEYS, fieldPath);

  const result = {};
  for (const field of ["entry", "intro", "afterEntry"]) {
    if (!Object.hasOwn(value, field)) continue;
    result[field] = normalizeText(
      value[field],
      `${fieldPath}.${field}`,
      DETAIL_LIMITS[field],
      true,
    );
  }

  if (Object.hasOwn(value, "services")) {
    if (!Array.isArray(value.services) || value.services.length === 0) {
      throw new Error(`${fieldPath}.services 必须是非空数组`);
    }
    if (value.services.length > MAX_SERVICE_COUNT) {
      throw new Error(`${fieldPath}.services 最多 ${MAX_SERVICE_COUNT} 项`);
    }
    result.services = value.services.map((service, index) => {
      const servicePath = `${fieldPath}.services[${index}]`;
      if (!isPlainObject(service)) {
        throw new Error(`${servicePath} 必须是对象`);
      }
      assertExactKeys(service, SERVICE_KEYS, servicePath);
      const normalizedService = {
        label: normalizeText(
          service.label,
          `${servicePath}.label`,
          MAX_SERVICE_LABEL_LENGTH,
        ),
        detail: normalizeText(
          service.detail,
          `${servicePath}.detail`,
          MAX_SERVICE_DETAIL_LENGTH,
        ),
      };
      if (Object.hasOwn(service, "addOns")) {
        normalizedService.addOns = normalizeAddOns(
          service.addOns,
          `${servicePath}.addOns`,
        );
      }
      return normalizedService;
    });
  }

  if (Object.keys(result).length === 0) {
    throw new Error(`${fieldPath} 至少需要一个内容区块`);
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_DETAILS_BYTES) {
    throw new Error(`${fieldPath} 规范 JSON 超过 32 KiB`);
  }
  return result;
}

/**
 * 校验不可变 staff ID 是否为小写规范 UUID v4。
 *
 * @param {unknown} value - staff ID 候选值。
 * @param {string} fieldPath - 错误字段路径。
 * @returns {string} 已验证的 UUID。
 */
export function requireStaffId(value, fieldPath) {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    throw new Error(`${fieldPath} 必须是小写规范 UUID v4`);
  }
  return value;
}

/**
 * 校验同步 revision 是否为非负安全整数。
 *
 * @param {unknown} value - revision 候选值。
 * @param {string} fieldPath - 错误字段路径。
 * @returns {number} 已验证的 revision。
 */
export function requireDetailsRevision(value, fieldPath) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldPath} 必须是非负安全整数`);
  }
  return value;
}

/**
 * 使用递归 key 排序和 UTF-8 JSON 生成跨 Python/Node 稳定文本。
 *
 * @param {unknown} value - 只含 JSON 数据类型的值。
 * @returns {string} 无无意义空白、数组顺序不变的规范 JSON。
 */
export function canonicalJson(value) {
  return JSON.stringify(sortJsonKeys(value));
}

/**
 * 计算计划合同中的 `sha256:<hex>` 版本标识。
 *
 * @param {unknown} value - 需要哈希的 JSON 值。
 * @returns {string} 带算法前缀的摘要。
 */
export function canonicalSha256(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

/**
 * 比较两个 details 是否具有相同规范语义。
 *
 * @param {unknown} left - 左侧 details。
 * @param {unknown} right - 右侧 details。
 * @returns {boolean} 规范正文相同则为 true。
 */
export function equalStaffDetails(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * 规范单个公开文本字段，并只为多行正文保留 LF。
 *
 * @param {unknown} value - 文本候选值。
 * @param {string} fieldPath - 错误字段路径。
 * @param {number} maximum - Unicode code point 上限。
 * @param {boolean} [allowLineFeed=false] - 是否规范并允许多行 LF。
 * @returns {string} 已规范的文本。
 */
function normalizeText(
  value,
  fieldPath,
  maximum,
  allowLineFeed = false,
) {
  if (typeof value !== "string") {
    throw new Error(`${fieldPath} 必须是字符串`);
  }
  const normalizedSource = (
    allowLineFeed ? value.replace(/\r\n?/g, "\n") : value
  );
  for (const character of normalizedSource) {
    const codePoint = character.codePointAt(0);
    const forbiddenControl =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff);
    if (forbiddenControl && !(allowLineFeed && codePoint === 0x0a)) {
      throw new Error(`${fieldPath} 包含控制字符`);
    }
  }
  const normalized = normalizedSource.trim();
  if (!normalized) {
    throw new Error(`${fieldPath} 不能为空字符串`);
  }
  if (Array.from(normalized).length > maximum) {
    throw new Error(`${fieldPath} 超过 ${maximum} 字`);
  }
  return normalized;
}

/**
 * 校验并规范单项服务下的有序附加项目。
 *
 * @param {unknown} value - `addOns` 数组候选值。
 * @param {string} fieldPath - 用于错误信息的字段路径。
 * @returns {string[]} 保持输入顺序、逐项 trim 后的单行文本。
 * @throws {Error} 数组为空、项目超限，或单项为空、超长、含 Cc/Cs 字符时抛出。
 */
function normalizeAddOns(value, fieldPath) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldPath} 必须是非空数组；无项目时请省略字段`);
  }
  if (value.length > MAX_SERVICE_ADD_ON_COUNT) {
    throw new Error(`${fieldPath} 最多 ${MAX_SERVICE_ADD_ON_COUNT} 项`);
  }
  return value.map((item, index) =>
    normalizeText(
      item,
      `${fieldPath}[${index}]`,
      MAX_SERVICE_ADD_ON_ITEM_LENGTH,
    ),
  );
}

function assertExactKeys(value, allowedKeys, fieldPath) {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw new Error(`${fieldPath} 包含未知字段：${unknownKeys.join(", ")}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonKeys(value[key])]),
  );
}
