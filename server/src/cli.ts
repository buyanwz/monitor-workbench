// 独立 CLI 入口：不依赖 Electron，方便开发调试与 e2e 测试。
//   MONITOR_DATA_DIR  数据目录（默认 <cwd>/.monitor-data）
//   MONITOR_PORT      端口（默认 17881）
//   MONITOR_NO_SCHEDULER=1  关调度器
//   MONITOR_MOCK_FETCHER=1 / MONITOR_TEST_MODE=1  测试用

import * as path from "node:path";
import { startLocalServer } from "./server";

async function main(): Promise<void> {
  const dataDir = process.env.MONITOR_DATA_DIR ?? path.join(process.cwd(), ".monitor-data");
  const port = process.env.MONITOR_PORT ? Number(process.env.MONITOR_PORT) : 17881;
  const running = await startLocalServer({ dataDir, port });
  console.log(`monitor-workbench local server: ${running.url}/ui/`);
  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e: unknown) => {
  console.error("server failed to start", e);
  process.exit(1);
});
