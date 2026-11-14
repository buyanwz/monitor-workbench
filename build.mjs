// 构建脚本：esbuild 打包 Electron 主进程与独立 server CLI；迁移文件拷到 dist 供开发运行。
//   node build.mjs          全部（main + server-cli + 迁移拷贝）
//   node build.mjs server   仅 server-cli（测试用）

import * as esbuild from "esbuild";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  logLevel: "warning",
};

async function main() {
  if (!only || only === "server") {
    await esbuild.build({
      ...common,
      entryPoints: [path.join(root, "server/src/cli.ts")],
      outfile: path.join(root, "dist/server-cli.cjs"),
    });
  }
  if (!only || only === "electron") {
    await esbuild.build({
      ...common,
      entryPoints: [path.join(root, "electron/main.ts")],
      outfile: path.join(root, "dist/electron/main.cjs"),
    });
    // 采集窗口 preload（MAIN world 注入脚本；与 main.cjs 同目录，打包时随 dist/electron/** 带走）
    await esbuild.build({
      ...common,
      entryPoints: [path.join(root, "electron/collect-preload.ts")],
      outfile: path.join(root, "dist/electron/collect-preload.cjs"),
    });
  }
  // 迁移文件随 dist 走（开发运行用；打包后走 extraResources → resources/migrations）
  await fs.mkdir(path.join(root, "dist/migrations"), { recursive: true });
  await fs.copyFile(
    path.join(root, "server/migrations/0001_init.sql"),
    path.join(root, "dist/migrations/0001_init.sql"),
  );
  console.log("build ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
