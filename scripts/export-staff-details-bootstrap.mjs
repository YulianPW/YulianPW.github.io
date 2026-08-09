import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOCAL_DETAILS_REVISION,
  normalizeStaffDetails,
  requireDetailsRevision,
  requireStaffId,
} from "./staff-details-contract.mjs";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_PATH = join(PROJECT_ROOT, "assets/data/data.json");

/**
 * 从站点读模型导出管理员 bootstrap 请求，不猜测任何云端 owner 映射。
 *
 * @description 修订号 0 的固定本地资料会被校验但不会导入云端。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const data = JSON.parse(await readFile(DATA_PATH, "utf8"));
  if (!Array.isArray(data.staff)) {
    throw new Error("data.json.staff 必须是数组");
  }
  const seen = new Set();
  const profiles = [];
  data.staff.forEach((staff, index) => {
    const staffId = requireStaffId(staff.staffId, `staff[${index}].staffId`);
    if (seen.has(staffId)) {
      throw new Error(`staff[${index}].staffId 重复：${staffId}`);
    }
    seen.add(staffId);
    const revision = requireDetailsRevision(
      staff.detailsRevision,
      `staff[${index}].detailsRevision`,
    );
    const details = normalizeStaffDetails(
      staff.details,
      `staff[${index}].details`,
    );
    if (revision === LOCAL_DETAILS_REVISION) {
      return;
    }
    if (revision !== 1) {
      throw new Error(`staff[${index}].detailsRevision bootstrap 时必须为 1`);
    }
    profiles.push({
      staffId,
      details,
    });
  });
  process.stdout.write(`${JSON.stringify({ profiles, confirm: false }, null, 2)}\n`);
}

await main().catch((error) => {
  console.error(`bootstrap 导出失败：${error.message}`);
  process.exitCode = 1;
});
