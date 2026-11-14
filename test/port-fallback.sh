#!/bin/bash
# 固定端口冲突兜底：17890 被占时，开 MONITOR_PORT_FALLBACK=1 的服务应顺延到 17891；
# 不开兜底时应启动失败（原行为保留）。全部本地，不连远端。
set -u
cd "$(dirname "$0")/.." || exit 1
node build.mjs server || { echo "PORT-FALLBACK: 服务构建失败"; exit 1; }

PORT=17890
DATA_DIR="$(mktemp -d /tmp/monitor-exe-portfb.XXXXXX)"
OCC_LOG=/tmp/monitor-exe-portfb-occupier.log
SRV_LOG=/tmp/monitor-exe-portfb-server.log
SRV_PID=""
OCC_PID=""

cleanup() {
  [ -n "$SRV_PID" ] && kill $SRV_PID 2>/dev/null
  [ -n "$OCC_PID" ] && kill $OCC_PID 2>/dev/null
  wait 2>/dev/null
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

# 占住 17890
node -e "require('node:net').createServer().listen($PORT,'127.0.0.1',()=>{console.log('occupier up');}); setTimeout(()=>{}, 90000);" > "$OCC_LOG" 2>&1 &
OCC_PID=$!
sleep 1
if ! grep -q "occupier up" "$OCC_LOG" 2>/dev/null; then echo "PORT-FALLBACK: 占位服务未起来"; exit 1; fi

export MONITOR_DATA_DIR="$DATA_DIR"
export MONITOR_PORT="$PORT"
export MONITOR_NO_SCHEDULER=1
export MONITOR_LOGIN_STATE_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
export MONITOR_DOWNLOAD_SIGNING_KEY="test-only-fake-signing-key"

# 1. 开兜底：应顺延到 17891 并正常服务
export MONITOR_PORT_FALLBACK=1
node dist/server-cli.cjs > "$SRV_LOG" 2>&1 &
SRV_PID=$!
OK=0
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:17891/api/v1/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
if [ "$OK" != "1" ]; then echo "PORT-FALLBACK: FAIL 兜底后 17891 未就绪"; tail -20 "$SRV_LOG"; exit 1; fi
if ! grep -q "17891" "$SRV_LOG"; then echo "PORT-FALLBACK: FAIL 启动日志未报 17891"; tail -5 "$SRV_LOG"; exit 1; fi
echo "PORT-FALLBACK: PASS 端口被占时顺延到 17891"
kill $SRV_PID 2>/dev/null; wait $SRV_PID 2>/dev/null; SRV_PID=""

# 2. 不开兜底：应启动失败退出（原行为）
unset MONITOR_PORT_FALLBACK
node dist/server-cli.cjs > "$SRV_LOG" 2>&1 &
SRV_PID=$!
FAIL_OK=0
for _ in $(seq 1 15); do
  if ! kill -0 $SRV_PID 2>/dev/null; then FAIL_OK=1; break; fi
  sleep 1
done
if [ "$FAIL_OK" != "1" ]; then echo "PORT-FALLBACK: FAIL 不开兜底时服务居然还活着"; exit 1; fi
wait $SRV_PID 2>/dev/null
if ! grep -qi "EADDRINUSE\|address already in use" "$SRV_LOG"; then echo "PORT-FALLBACK: FAIL 失败原因不是端口被占"; tail -10 "$SRV_LOG"; exit 1; fi
echo "PORT-FALLBACK: PASS 不开兜底时启动失败并报端口被占"
SRV_PID=""
echo "== 结果：通过 2，失败 0 =="
exit 0
