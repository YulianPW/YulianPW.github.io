import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeStaffDetails,
  requireDetailsRevision,
  requireStaffId,
} from "./staff-details-contract.mjs";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATA_PATH = join(PROJECT_ROOT, "assets/data/data.json");
const VALID_TAGS = new Set(["绿色陪", "女喘陪", "视频陪", "未进店"]);

/**
 * 校验值是否为去除首尾空白后的非空字符串。
 *
 * @param {unknown} value - 待校验的字段值。
 * @param {string} fieldPath - 用于错误信息的 JSON 字段路径。
 * @returns {asserts value is string}
 * @throws {Error} 字段不是非空字符串时抛出。
 */
function assertNonEmptyString(value, fieldPath) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldPath} 必须是非空字符串`);
  }
}

/**
 * 校验单条陪陪资料的结构化介绍。
 *
 * @description 可选区块不允许用空字符串占位；服务项目使用必填的
 * `{label, detail}` 与可选有序 `addOns` 字符串数组，不解析金额或计价单位。
 *
 * @param {Record<string, unknown>} item - 单条 staff 记录。
 * @param {number} index - 记录在 staff 数组中的索引。
 * @returns {void}
 * @throws {Error} 介绍结构、字段或服务项目不符合契约时抛出。
 */
function validateDetails(item, index) {
  const itemPath = `staff[${index}](${String(item.name ?? "未命名")})`;
  if (Object.hasOwn(item, "desc")) {
    throw new Error(`${itemPath}.desc 已停用，请迁移到 details`);
  }
  normalizeStaffDetails(item.details, `${itemPath}.details`);
}

/**
 * 校验站点陪陪数据的顶层结构和稳定身份字段。
 *
 * @param {unknown} data - 从 `assets/data/data.json` 解析的 JSON 数据。
 * @returns {{staffCount: number, serviceCount: number}} 校验通过后的统计信息。
 * @throws {Error} 顶层结构、标签、姓名、KP 或详情契约无效时抛出。
 */
function validateStaffData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("data.json 顶层必须是对象");
  }
  if (!Array.isArray(data.staff)) {
    throw new Error("data.json.staff 必须是数组");
  }

  const names = new Set();
  const staffIds = new Set();
  let serviceCount = 0;
  data.staff.forEach((item, index) => {
    const itemPath = `staff[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${itemPath} 必须是对象`);
    }
    assertNonEmptyString(item.name, `${itemPath}.name`);
    assertNonEmptyString(item.tags, `${itemPath}.tags`);
    const staffId = requireStaffId(item.staffId, `${itemPath}.staffId`);
    requireDetailsRevision(item.detailsRevision, `${itemPath}.detailsRevision`);
    if (staffIds.has(staffId)) {
      throw new Error(`${itemPath}.staffId 重复：${staffId}`);
    }
    staffIds.add(staffId);
    if (!VALID_TAGS.has(item.tags)) {
      throw new Error(`${itemPath}.tags 不是合法标签：${item.tags}`);
    }
    if (names.has(item.name)) {
      throw new Error(`${itemPath}.name 重复：${item.name}`);
    }
    names.add(item.name);

    if (typeof item.social !== "string") {
      throw new Error(`${itemPath}.social 必须是字符串`);
    }
    if (
      Object.hasOwn(item, "kp") &&
      (!Number.isFinite(item.kp) || item.kp <= 0)
    ) {
      throw new Error(`${itemPath}.kp 必须是正数`);
    }

    validateDetails(item, index);
    serviceCount += item.details.services?.length ?? 0;
  });

  return { staffCount: data.staff.length, serviceCount };
}

/**
 * 读取并校验站点陪陪数据文件。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const dataFlagIndex = process.argv.indexOf("--data");
  const dataPath =
    dataFlagIndex >= 0
      ? resolve(process.argv[dataFlagIndex + 1] || "")
      : DEFAULT_DATA_PATH;
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  const result = validateStaffData(data);
  console.log(
    `陪陪数据校验通过：${result.staffCount} 条记录，${result.serviceCount} 个服务项目`,
  );
}

await main();
