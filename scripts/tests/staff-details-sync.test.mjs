import assert from "node:assert/strict";
import { watch, writeFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  canonicalSha256,
  MAX_SNAPSHOT_BYTES,
  normalizeStaffDetails,
} from "../staff-details-contract.mjs";
import {
  mergeStaffDetails,
  normalizeStaffDetailsSnapshot,
  verifyMergedStaffDetails,
} from "../staff-details-sync-core.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SYNC_SCRIPT = resolve(TEST_DIR, "../sync-staff-details.mjs");
const CONTRACT_FIXTURE = resolve(
  TEST_DIR,
  "../fixtures/staff-details-contract.v1.json",
);
const STAFF_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_STAFF_ID = "22222222-2222-4222-8222-222222222222";
const XIAOMA_KP_ADD_ONS = Object.freeze([
  "自嗨单卡",
  "剧情",
  "打屁股",
  "水声",
  "调教",
  "寸止",
  "看lu",
  "绿帽",
  "狗叫",
  "旁听",
  "远程玩具+20",
]);

test("完整快照通过内容哈希校验并保持服务顺序", () => {
  const snapshot = buildSnapshot([
    buildProfile({
      details: {
        intro: "emoji 🐱 与组合字符 e\u0301",
        services: [
          {
            label: "KP",
            detail: "58/10",
            addOns: [...XIAOMA_KP_ADD_ONS],
          },
          { label: "TS", detail: "99/30分" },
        ],
      },
    }),
  ]);

  const normalized = normalizeStaffDetailsSnapshot(snapshot);

  assert.equal(normalized.snapshotVersion, snapshot.snapshotVersion);
  assert.deepEqual(normalized.profiles[0].details.services, [
    {
      label: "KP",
      detail: "58/10",
      addOns: [...XIAOMA_KP_ADD_ONS],
    },
    { label: "TS", detail: "99/30分" },
  ]);
});

test("多行正文规范跨平台换行且附加项目保持数组顺序", () => {
  assert.deepEqual(
    normalizeStaffDetails({
      entry: "第一行\r\n第二行",
      intro: "介绍一\r介绍二",
      afterEntry: "说明一\n说明二",
      services: [
        {
          label: "KP",
          detail: "66/10分",
          addOns: [" 水声 +20 ", "远程玩具+30"],
        },
      ],
    }),
    {
      entry: "第一行\n第二行",
      intro: "介绍一\n介绍二",
      afterEntry: "说明一\n说明二",
      services: [
        {
          label: "KP",
          detail: "66/10分",
          addOns: ["水声 +20", "远程玩具+30"],
        },
      ],
    },
  );
  assert.throws(
    () => normalizeStaffDetails({ intro: "介绍一\t介绍二" }),
    /控制字符/,
  );
  assert.throws(
    () =>
      normalizeStaffDetails({
        services: [{ label: "KP\nTS", detail: "99/30分" }],
      }),
    /控制字符/,
  );
  assert.throws(
    () => normalizeStaffDetails({ intro: "介绍一\n介绍二\t" }),
    /控制字符/,
  );
});

test("addOns 严格校验数量、单行文本、Unicode 长度和旧字段", () => {
  for (const item of [
    "水声\n+20",
    "水声\r\n+20",
    "水声\t+20",
    "\u0000",
    "\u0085",
    "\ud800",
  ]) {
    assert.throws(
      () =>
        normalizeStaffDetails({
          services: [{ label: "KP", detail: "99/30分", addOns: [item] }],
        }),
      /控制字符/,
    );
  }
  assert.throws(
    () =>
      normalizeStaffDetails({
        services: [{ label: "KP", detail: "99/30分", addOns: [] }],
      }),
    /必须是非空数组/,
  );
  assert.throws(
    () =>
      normalizeStaffDetails({
        services: [{ label: "KP", detail: "99/30分", addOns: ["  "] }],
      }),
    /不能为空字符串/,
  );
  assert.throws(
    () =>
      normalizeStaffDetails({
        services: [{ label: "KP", detail: "99/30分", addOns: [20] }],
      }),
    /必须是字符串/,
  );
  assert.throws(
    () =>
      normalizeStaffDetails({
        services: [
          { label: "KP", detail: "99/30分", addOns: Array(31).fill("项目") },
        ],
      }),
    /最多 30 项/,
  );
  const maximumItem = "🧩".repeat(128);
  const normalized = normalizeStaffDetails({
    services: [
      {
        label: "KP",
        detail: "99/30分",
        addOns: Array.from({ length: 30 }, (_, index) =>
          index === 29 ? maximumItem : `项目 ${index + 1}`,
        ),
      },
    ],
  });
  assert.equal(normalized.services[0].addOns.length, 30);
  assert.equal(Array.from(normalized.services[0].addOns[29]).length, 128);
  assert.throws(
    () =>
      normalizeStaffDetails({
        services: [
          { label: "KP", detail: "99/30分", addOns: ["🧩".repeat(129)] },
        ],
      }),
    /超过 128 字/,
  );
  assert.throws(
    () =>
      normalizeStaffDetails({
        services: [{ label: "KP", detail: "99/30分", addOn: "水声 +20" }],
      }),
    /未知字段：addOn/,
  );
});

test("Node 快照与 Python 共用合同 fixture 完全一致", async () => {
  const fixture = JSON.parse(await readFile(CONTRACT_FIXTURE, "utf8"));
  const normalized = normalizeStaffDetailsSnapshot(fixture.snapshot);

  assert.equal(fixture.contractVersion, 1);
  assert.deepEqual(normalized, fixture.snapshot);
  assert.equal(
    fixture.localStaff.detailsRevision,
    fixture.snapshot.profiles[0].revision,
  );
  assert.deepEqual(fixture.localStaff.details, fixture.snapshot.profiles[0].details);
});

test("拒绝未知 schema、重复 ID、非稳定排序和伪造哈希", () => {
  const valid = buildSnapshot([buildProfile()]);
  assert.throws(
    () => normalizeStaffDetailsSnapshot({ ...valid, schemaVersion: 2 }),
    /不支持的 schemaVersion/,
  );
  assert.throws(
    () =>
      normalizeStaffDetailsSnapshot(
        buildSnapshot([buildProfile(), buildProfile()]),
      ),
    /重复/,
  );
  assert.throws(
    () =>
      normalizeStaffDetailsSnapshot(
        buildSnapshot([
          buildProfile({ staffId: SECOND_STAFF_ID }),
          buildProfile({ staffId: STAFF_ID }),
        ]),
      ),
    /严格升序/,
  );
  assert.throws(
    () => normalizeStaffDetailsSnapshot({ ...valid, snapshotVersion: `sha256:${"0".repeat(64)}` }),
    /与正文不匹配/,
  );
});

test("合并只更新 details 与 detailsRevision 并保持数组顺序", () => {
  const original = buildLocalData([
    buildStaff({ staffId: STAFF_ID, name: "第一位" }),
    buildStaff({ staffId: SECOND_STAFF_ID, name: "第二位" }),
  ]);
  const snapshot = normalizeStaffDetailsSnapshot(
    buildSnapshot([
      buildProfile({ staffId: STAFF_ID, revision: 2, details: { intro: "新介绍" } }),
      buildProfile({ staffId: SECOND_STAFF_ID }),
    ]),
  );

  const result = mergeStaffDetails(original, snapshot);

  assert.deepEqual(result.changedStaffIds, [STAFF_ID]);
  assert.deepEqual(result.data.staff.map((item) => item.name), ["第一位", "第二位"]);
  assert.equal(result.data.staff[0].detailsRevision, 2);
  assert.deepEqual(result.data.staff[0].details, { intro: "新介绍" });
  assert.equal(result.data.staff[0].social, original.staff[0].social);
  verifyMergedStaffDetails(result.data, snapshot);
});

test("拒绝集合差异、revision 回退和同 revision 异文", () => {
  const local = buildLocalData([buildStaff()]);
  const missing = normalizeStaffDetailsSnapshot(buildSnapshot([]));
  assert.throws(() => mergeStaffDetails(local, missing), /集合不一致/);

  const older = normalizeStaffDetailsSnapshot(
    buildSnapshot([buildProfile({ revision: 1 })]),
  );
  assert.throws(
    () => mergeStaffDetails(buildLocalData([buildStaff({ revision: 2 })]), older),
    /早于本地/,
  );

  const divergent = normalizeStaffDetailsSnapshot(
    buildSnapshot([buildProfile({ details: { intro: "不同正文" } })]),
  );
  assert.throws(() => mergeStaffDetails(local, divergent), /同 revision 正文不一致/);
});

test("check 模式报告变化但不写文件", async () => {
  const fixture = await createFixture({ remoteRevision: 2 });
  const before = await readFile(fixture.dataPath, "utf8");
  const beforeMtime = (await stat(fixture.dataPath)).mtimeMs;

  const result = await runSync([
    "--check",
    "--source",
    pathToFileURL(fixture.snapshotPath).href,
    "--data",
    fixture.dataPath,
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /检测到变化：1 人/);
  assert.equal(await readFile(fixture.dataPath, "utf8"), before);
  assert.equal((await stat(fixture.dataPath)).mtimeMs, beforeMtime);
});

test("apply 对干净 Git 目标原子更新，重复拉取为 no-op", async () => {
  const fixture = await createFixture({ remoteRevision: 2, initializeGit: true });
  const source = pathToFileURL(fixture.snapshotPath).href;
  const first = await runSync([
    "--apply",
    "--source",
    source,
    "--data",
    fixture.dataPath,
  ]);
  assert.equal(first.code, 0, first.stderr);
  const updated = JSON.parse(await readFile(fixture.dataPath, "utf8"));
  assert.equal(updated.staff[0].detailsRevision, 2);
  assert.deepEqual(updated.staff[0].details, { intro: "远端介绍" });

  commitTarget(fixture.root);
  const beforeMtime = (await stat(fixture.dataPath)).mtimeMs;
  const second = await runSync([
    "--apply",
    "--source",
    source,
    "--data",
    fixture.dataPath,
  ]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /结果：no-op/);
  assert.equal((await stat(fixture.dataPath)).mtimeMs, beforeMtime);
});

test("apply 在目标 dirty 时失败且不覆盖用户变更", async () => {
  const fixture = await createFixture({ remoteRevision: 2, initializeGit: true });
  const dirtyData = buildLocalData([buildStaff({ name: "用户未提交修改" })]);
  const dirtyText = `${JSON.stringify(dirtyData, null, 2)}\n`;
  await writeFile(fixture.dataPath, dirtyText, "utf8");

  const result = await runSync([
    "--apply",
    "--source",
    pathToFileURL(fixture.snapshotPath).href,
    "--data",
    fixture.dataPath,
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /有未提交变更/);
  assert.equal(await readFile(fixture.dataPath, "utf8"), dirtyText);
});

test("apply 即使远端 no-op 也拒绝 dirty 目标", async () => {
  const fixture = await createFixture({
    remoteRevision: 1,
    initializeGit: true,
    localData: buildLocalData([buildStaff({ details: { intro: "远端介绍" } })]),
  });
  const dirtyText = `${(await readFile(fixture.dataPath, "utf8")).trimEnd()}\n `;
  await writeFile(fixture.dataPath, dirtyText, "utf8");

  const result = await runSync([
    "--apply",
    "--source",
    pathToFileURL(fixture.snapshotPath).href,
    "--data",
    fixture.dataPath,
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /有未提交变更/);
  assert.equal(await readFile(fixture.dataPath, "utf8"), dirtyText);
});

test("apply 拒绝覆盖执行期间出现的人工修改", async () => {
  const fixture = await createFixture({ remoteRevision: 2, initializeGit: true });
  const concurrentData = buildLocalData([buildStaff({ name: "执行期间人工修改" })]);
  const concurrentText = `${JSON.stringify(concurrentData, null, 2)}\n`;
  let changed = false;
  const watcher = watch(dirname(fixture.dataPath), (_eventType, filename) => {
    if (changed || !filename?.endsWith(".tmp")) return;
    changed = true;
    writeFileSync(fixture.dataPath, concurrentText, "utf8");
  });

  try {
    const result = await runSync([
      "--apply",
      "--source",
      pathToFileURL(fixture.snapshotPath).href,
      "--data",
      fixture.dataPath,
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /执行期间.*发生变化|有未提交变更/);
    assert.equal(await readFile(fixture.dataPath, "utf8"), concurrentText);
  } finally {
    watcher.close();
  }
});

test("临时文件校验失败时保留原文件", async () => {
  const invalidLocal = buildLocalData([buildStaff({ tags: "非法标签" })]);
  const fixture = await createFixture({
    remoteRevision: 2,
    initializeGit: true,
    localData: invalidLocal,
  });
  const before = await readFile(fixture.dataPath, "utf8");

  const result = await runSync([
    "--apply",
    "--source",
    pathToFileURL(fixture.snapshotPath).href,
    "--data",
    fixture.dataPath,
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /不是合法标签/);
  assert.equal(await readFile(fixture.dataPath, "utf8"), before);
});

test("HTTP 条件请求接受 loopback 304", async () => {
  const expectedEtag = '"snapshot-etag"';
  const server = createServer((request, response) => {
    assert.equal(request.headers["if-none-match"], expectedEtag);
    response.writeHead(304);
    response.end();
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  try {
    const result = await runSync([
      "--check",
      "--source",
      `http://127.0.0.1:${address.port}/snapshot`,
      "--if-none-match",
      expectedEtag,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /未变化（304）/);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("file fixture 拒绝符号链接", async () => {
  const fixture = await createFixture({ remoteRevision: 2 });
  const linkedSnapshotPath = join(fixture.root, "linked-snapshot.json");
  await symlink(fixture.snapshotPath, linkedSnapshotPath);

  const result = await runSync([
    "--check",
    "--source",
    pathToFileURL(linkedSnapshotPath).href,
    "--data",
    fixture.dataPath,
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /普通文件.*符号链接/);
});

test("file fixture 在读取前拒绝超过 5 MiB 的普通文件", async () => {
  const fixture = await createFixture({ remoteRevision: 2 });
  await truncate(fixture.snapshotPath, MAX_SNAPSHOT_BYTES + 1);

  const result = await runSync([
    "--check",
    "--source",
    pathToFileURL(fixture.snapshotPath).href,
    "--data",
    fixture.dataPath,
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /超过 5 MiB/);
});

async function createFixture({
  remoteRevision,
  initializeGit = false,
  localData = buildLocalData([buildStaff()]),
}) {
  const root = await mkdtemp(join(tmpdir(), "yulian-staff-details-"));
  const dataPath = join(root, "assets/data/data.json");
  const snapshotPath = join(root, "snapshot.json");
  await mkdir(dirname(dataPath), { recursive: true });
  await writeFile(dataPath, `${JSON.stringify(localData, null, 2)}\n`, "utf8");
  await writeFile(
    snapshotPath,
    `${JSON.stringify(
      buildSnapshot([
        buildProfile({ revision: remoteRevision, details: { intro: "远端介绍" } }),
      ]),
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (initializeGit) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    commitTarget(root);
  }
  return { root, dataPath, snapshotPath };
}

function commitTarget(root) {
  execFileSync("git", ["add", "assets/data/data.json"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
}

function runSync(argumentsList) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SYNC_SCRIPT, ...argumentsList], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function buildSnapshot(profiles) {
  const payload = { schemaVersion: 1, coverage: "full", profiles };
  return {
    schemaVersion: 1,
    snapshotVersion: canonicalSha256(payload),
    generatedAt: "2026-08-06T00:00:00Z",
    coverage: "full",
    profiles,
  };
}

function buildProfile({
  staffId = STAFF_ID,
  revision = 1,
  details = { intro: "本地介绍" },
} = {}) {
  return {
    staffId,
    revision,
    updatedAt: "2026-08-06T00:00:00Z",
    details,
  };
}

function buildLocalData(staff) {
  return { staff };
}

function buildStaff({
  staffId = STAFF_ID,
  revision = 1,
  name = "测试陪陪",
  tags = "视频陪",
  details = { intro: "本地介绍" },
} = {}) {
  return {
    staffId,
    detailsRevision: revision,
    tags,
    name,
    social: "twitter://user?screen_name=test",
    mediaFolder: "test-staff",
    details,
  };
}
