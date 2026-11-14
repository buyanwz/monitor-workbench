// 浏览器采集探针式验证（手动跑，不进 npm test 必跑项）：
// 把 harness + preload 打包到临时目录，用 xvfb-run 拉起 Electron 跑，
// 对本地测试服务验证截获→映射→存档→下载→登录窗全链路。只连 127.0.0.1，绝不访问快手。
// 跑法：node test/browser-collect-verify.mjs

import * as esbuild from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronPath = createRequire(import.meta.url)("electron");

async function main() {
  const xvfb = spawnSync("which", ["xvfb-run"], { encoding: "utf8" });
  if (xvfb.status !== 0) {
    console.error("BROWSER-COLLECT-VERIFY: 需要 xvfb-run（无头跑 Electron），未找到");
    process.exit(2);
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bc-verify-"));
  const dataDir = path.join(tmp, "data");
  const port = 17899;
  await fs.mkdir(dataDir, { recursive: true });
  const common = {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    logLevel: "warning",
  };
  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, "test/browser-collect-harness.ts")],
    outfile: path.join(tmp, "harness.cjs"),
  });
  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, "electron/collect-preload.ts")],
    outfile: path.join(tmp, "collect-preload.cjs"),
  });
  console.log(`BROWSER-COLLECT-VERIFY: harness 已打包到 ${tmp}`);

  const child = spawn(
    "xvfb-run",
    ["-a", electronPath, "--no-sandbox", path.join(tmp, "harness.cjs")],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        BC_VERIFY_DIR: dataDir,
        BC_VERIFY_PORT: String(port),
        BC_VERIFY_PRELOAD: path.join(tmp, "collect-preload.cjs"),
        BC_VERIFY_MIGRATIONS: path.join(root, "server/migrations"),
        BC_VERIFY_RENDERER: path.join(root, "renderer"),
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      },
    },
  );
  const killer = setTimeout(() => {
    console.error("BROWSER-COLLECT-VERIFY: 超时 180 秒，杀掉 Electron");
    child.kill("SIGKILL");
  }, 180_000);
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(killer);
  if (code === 0) {
    await fs.rm(tmp, { recursive: true, force: true });
  } else {
    console.error(`BROWSER-COLLECT-VERIFY: 失败，临时目录保留在 ${tmp} 供排查`);
  }
  process.exit(code ?? 1);
}

main().catch((e) => {
  console.error("BROWSER-COLLECT-VERIFY ERROR", e);
  process.exit(2);
});
