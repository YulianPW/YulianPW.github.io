import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOCAL_DETAILS_REVISION,
  normalizeStaffDetails,
  requireDetailsRevision,
  requireStaffId,
} from "./staff-details-contract.mjs";
import { validateStaffData } from "./validate-staff-data.mjs";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATA_PATH = join(PROJECT_ROOT, "assets/data/data.json");

/**
 * 从站点读模型导出管理员 bootstrap 请求或只读 staff 名录。
 *
 * @description 修订号 0 的固定本地资料会被校验但不会导入云端。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const data = JSON.parse(await readFile(options.dataPath, "utf8"));
  validateStaffData(data);
  const catalogProfiles = data.staff.map((staff, index) => {
    const staffId = requireStaffId(staff.staffId, `staff[${index}].staffId`);
    const detailsRevision = requireDetailsRevision(
      staff.detailsRevision,
      `staff[${index}].detailsRevision`,
    );
    const details = normalizeStaffDetails(
      staff.details,
      `staff[${index}].details`,
    );
    return {
      name: staff.name,
      staffId,
      detailsRevision,
      details,
    };
  });
  if (options.catalog) {
    process.stdout.write(
      `${JSON.stringify({ profiles: catalogProfiles }, null, 2)}\n`,
    );
    return;
  }

  const profiles = catalogProfiles.flatMap((profile, index) => {
    if (profile.detailsRevision === LOCAL_DETAILS_REVISION) return [];
    if (profile.detailsRevision !== 1) {
      throw new Error(`staff[${index}].detailsRevision bootstrap 时必须为 1`);
    }
    return [{ staffId: profile.staffId, details: profile.details }];
  });
  process.stdout.write(`${JSON.stringify({ profiles, confirm: false }, null, 2)}\n`);
}

function parseArguments(argumentsList) {
  const knownFlags = new Set(["--catalog", "--data"]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!knownFlags.has(argument)) {
      throw new Error(`未知参数：${argument}`);
    }
    if (argument === "--data") index += 1;
  }
  const dataIndex = argumentsList.indexOf("--data");
  if (dataIndex >= 0) {
    const value = argumentsList[dataIndex + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--data 缺少值");
    }
  }
  return {
    catalog: argumentsList.includes("--catalog"),
    dataPath:
      dataIndex >= 0
        ? resolve(argumentsList[dataIndex + 1])
        : DEFAULT_DATA_PATH,
  };
}

await main().catch((error) => {
  console.error(`bootstrap 导出失败：${error.message}`);
  process.exitCode = 1;
});
