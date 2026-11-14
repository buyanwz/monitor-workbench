// 单文件上限专项测试：配合 test/e2e-limits.sh（TEST_MAX_FILE_BYTES=1024）。
// mock 假媒体约 1–5KB，必然超限；验证拒存、告警、只留元数据。

const BASE = process.argv[2] || "http://127.0.0.1:8789";
let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`);
  }
}

async function req(method, path, body = undefined, token = undefined) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }
  return { status: res.status, data, text };
}

async function main() {
  const health = await req("GET", "/api/v1/health");
  check("health 200", health.status === 200 && health.data.ok === true, JSON.stringify(health.data));

  const setup = await req("POST", "/api/v1/auth/setup", { password: "test-access-pass-123" });
  check("设置口令成功", setup.status === 200 && !!setup.data.token, JSON.stringify(setup.data));
  const token = setup.data.token;

  const created = await req(
    "POST",
    "/api/v1/accounts",
    { platform: "kuaishou", name: "上限测试", home_url: "https://www.kuaishou.com/profile/mock-normal", account_id: "mock:normal" },
    token,
  );
  check("新增账号成功", created.status === 201, JSON.stringify(created.data));
  const accountId = created.data.account.id;
  const ls = await req("POST", `/api/v1/accounts/${accountId}/login-state`, { login_state: "FAKE-LOGIN-STATE" }, token);
  check("配置登录态成功", ls.status === 200, JSON.stringify(ls.data));

  const cron = await req("POST", "/api/v1/_test/run-cron", { cron: "0 0 * * *" }, token);
  check("建当日任务", cron.status === 200 && cron.data.created === 1, JSON.stringify(cron.data));
  const tick = await req("POST", "/api/v1/_test/run-cron", { cron: "* * * * *" }, token);
  check("触发认领任务", tick.status === 200 && tick.data.claimed === 1, JSON.stringify(tick.data));

  const tasks = await req("GET", `/api/v1/tasks?account_id=${accountId}&page_size=5`, undefined, token);
  const task = tasks.data.tasks?.[0];
  check("任务标部分失败（文件超限）", task?.status === "partial" && task?.collected_count === 5, JSON.stringify(task));

  const works = await req("GET", `/api/v1/works?account_id=${accountId}&page_size=50`, undefined, token);
  const list = works.data.groups?.flatMap((g) => g.works) ?? [];
  check("超限仍保留 5 条元数据", list.length === 5, String(list.length));
  check("超限文件全部标缺失", list.every((w) => w.file_status === "missing" && !w.has_video && !w.has_cover), JSON.stringify(list.map((w) => w.file_status)));

  const usage = await req("GET", "/api/v1/storage/usage", undefined, token);
  check("存储占用为 0（无文件入库）", usage.data.used_bytes === 0, JSON.stringify(usage.data));

  const notifs = await req("GET", "/api/v1/notifications?type=file_too_large&page_size=5", undefined, token);
  check("超限告警已发", notifs.data.total >= 1, JSON.stringify(notifs.data.total));

  console.log(`\n== 结果：通过 ${passed}，失败 ${failed} ==`);
  if (failed > 0) {
    console.log("失败用例：");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("E2E-limits 异常退出：", e);
  process.exit(1);
});
