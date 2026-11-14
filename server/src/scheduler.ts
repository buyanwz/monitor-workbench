// 程序内调度器：替代 Cloudflare Cron 触发器。
// 规则（设计第六节，时间一律北京时间 Asia/Shanghai）：
//   每天 collect_hour（固定 8:00）建当日采集任务；08:30 漏跑补采；03:00 到期清理＋每日快照；
//   每分钟处理待处理任务（分片＋断点续跑，走同一 runScheduled 分发）。
// 诚实限制：电脑关机或程序没开时，定时任务跑不了；下次打开程序时会补建当天的任务，
// 过去日子的漏跑须用界面「漏跑补采」手动补指定日期。

import { ensureDailyTasks, processPendingTasks } from "./collect";
import { runCleanup } from "./cleanup";
import { snapshotBackup } from "./backup";
import { getSettingInt, type Env } from "./db";
import { shanghaiDate } from "./util";

const SHANGHAI = "Asia/Shanghai";

function shanghaiParts(ms: number): { date: string; hm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hm: `${get("hour")}:${get("minute")}` };
}

function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

export interface SchedulerHandle {
  stop(): void;
}

export function startScheduler(env: Env, opts?: { tickMs?: number }): SchedulerHandle {
  const tickMs = opts?.tickMs ?? 30_000;
  const fired = new Map<string, string>(); // job -> shanghai date
  let minuteRunning = false;
  let dailyRunning = false;
  let lastMinuteStart = 0;
  let stopped = false;

  const runMinuteJob = async () => {
    if (minuteRunning) return;
    minuteRunning = true;
    lastMinuteStart = Date.now();
    try {
      await processPendingTasks(env);
    } catch (e) {
      console.error("[scheduler] 处理待处理任务失败", e);
    } finally {
      minuteRunning = false;
    }
  };

  const runDailyJob = async (job: string, date: string, fn: () => Promise<unknown>) => {
    if (fired.get(job) === date || dailyRunning) return;
    dailyRunning = true;
    try {
      await fn();
      fired.set(job, date);
    } catch (e) {
      console.error(`[scheduler] ${job} 失败`, e);
    } finally {
      dailyRunning = false;
    }
  };

  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    const { date, hm } = shanghaiParts(now);
    const nowMin = hmToMinutes(hm);

    // 每分钟任务：距上次启动 ≥50 秒即跑（tick 30 秒，实际约 60 秒一轮）
    if (now - lastMinuteStart >= 50_000) void runMinuteJob();

    const collectHour = await getSettingInt(env.DB, "collect_hour").catch(() => 8);
    const dailyAt = collectHour * 60;
    const backfillAt = dailyAt + 30;
    const cleanupAt = 3 * 60;
    // 2 分钟窗口，防 tick 漂移错过整点
    if (nowMin >= dailyAt && nowMin < dailyAt + 2) {
      void runDailyJob("daily", date, () => ensureDailyTasks(env, date, "scheduled"));
    }
    if (nowMin >= backfillAt && nowMin < backfillAt + 2) {
      void runDailyJob("backfill", date, () => ensureDailyTasks(env, date, "backfill"));
    }
    if (nowMin >= cleanupAt && nowMin < cleanupAt + 2) {
      void runDailyJob("cleanup", date, async () => {
        await runCleanup(env);
        await snapshotBackup(env);
      });
    }
  };

  // 启动即补建今天的任务（幂等，已有则 0 条），并立即跑一轮待处理任务；
  // 这样早上打开程序也能采，不必等到下一个整点。
  void (async () => {
    try {
      await ensureDailyTasks(env, shanghaiDate(Date.now()), "scheduled");
    } catch (e) {
      console.error("[scheduler] 启动补建今日任务失败", e);
    }
    void tick();
  })();

  const timer = setInterval(() => void tick(), tickMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
