#!/bin/bash
# 本地 exe 版端到端：起一个全新临时数据目录的本地服务，跑 node 端到端，跑完即杀。
# 全部假数据、假密钥，不连远端、不登录、不部署。调度器关闭（测试手动驱动 cron）。
set -u
cd "$(dirname "$0")/.." || exit 1
node build.mjs server || { echo "E2E: 服务构建失败"; exit 1; }
DATA_DIR="$(mktemp -d /tmp/monitor-exe-e2e.XXXXXX)"
PORT=17888
export MONITOR_DATA_DIR="$DATA_DIR"
export MONITOR_PORT="$PORT"
export MONITOR_NO_SCHEDULER=1
export MONITOR_MOCK_FETCHER=1
export MONITOR_TEST_MODE=1
export MONITOR_LOGIN_STATE_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
export MONITOR_DOWNLOAD_SIGNING_KEY="test-only-fake-signing-key"
node dist/server-cli.cjs > /tmp/monitor-exe-e2e-server.log 2>&1 &
SRV_PID=$!
trap 'kill $SRV_PID 2>/dev/null; wait $SRV_PID 2>/dev/null; rm -rf "$DATA_DIR"' EXIT
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -sf "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then
  echo "E2E: 本地服务未能在 60 秒内就绪，日志："
  tail -30 /tmp/monitor-exe-e2e-server.log
  exit 1
fi
node test/e2e.mjs "http://127.0.0.1:$PORT"
STATUS=$?
exit $STATUS
