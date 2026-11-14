#!/bin/bash
# v0.2.0 新增路由检查：起一个全新临时数据目录的本地服务（文件模式密钥，调度器关闭），
# 跑 test/browser-routes-check.mjs，跑完即杀。手动跑，不进 npm test。
set -u
cd "$(dirname "$0")/.." || exit 1
node build.mjs server || { echo "BROWSER-ROUTES: 服务构建失败"; exit 1; }
DATA_DIR="$(mktemp -d /tmp/monitor-exe-broutes.XXXXXX)"
PORT=17892
export MONITOR_DATA_DIR="$DATA_DIR"
export MONITOR_PORT="$PORT"
export MONITOR_NO_SCHEDULER=1
export MONITOR_MOCK_FETCHER=1
export MONITOR_TEST_MODE=1
# 注意：故意不设 MONITOR_LOGIN_STATE_KEY / MONITOR_DOWNLOAD_SIGNING_KEY（文件模式，轮换可写回）
node dist/server-cli.cjs > /tmp/monitor-exe-broutes-server.log 2>&1 &
SRV_PID=$!
trap 'kill $SRV_PID 2>/dev/null; wait $SRV_PID 2>/dev/null; rm -rf "$DATA_DIR"' EXIT
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -sf "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then
  echo "BROWSER-ROUTES: 本地服务未能在 60 秒内就绪，日志："
  tail -30 /tmp/monitor-exe-broutes-server.log
  exit 1
fi
node test/browser-routes-check.mjs "http://127.0.0.1:$PORT"
STATUS=$?
exit $STATUS
