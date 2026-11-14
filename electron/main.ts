// Electron 主进程：单实例、启动本地服务、打开窗口、自动更新、菜单。
// 服务跑在主进程内（Node http + node:sqlite + 本地文件），不另起子进程；
// 渲染层只通过同源 HTTP 与服务说话，不用 IPC、不开 Node 集成。

import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { startLocalServer, type RunningServer } from "../server/src/server";

const SMOKE = process.env.MONITOR_SMOKE === "1";

let mainWindow: BrowserWindow | null = null;
let running: RunningServer | null = null;
let updateCheckInFlight = false;
let manualCheckPending = false;

function dataDir(): string {
  return process.env.MONITOR_DATA_DIR || app.getPath("userData");
}

function log(...args: unknown[]): void {
  console.log("[main]", ...args);
}

async function createWindow(serverUrl: string): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    title: "监控账号工作台",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(`${serverUrl}/ui/`);

  if (SMOKE) {
    // 无头冒烟：走完整首用流程（设口令 → 进应用 → 看板渲染）且 API 通，超时 45 秒判失败。
    // 烟囱口令只写进本次临时数据目录，随目录一起丢弃，不是真实凭证。
    const timer = setTimeout(() => {
      console.log("SMOKE FAIL: timeout");
      app.exit(1);
    }, 45_000);
    try {
      const info = (await mainWindow.webContents.executeJavaScript(
        `(async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const visible = (el) => !!el && !el.hidden && el.offsetParent !== null;
          // 1. 等鉴权视图出现（全新库应为设置口令表单）
          let mode = "";
          for (let i = 0; i < 40; i++) {
            if (visible(document.querySelector("#setup-form"))) { mode = "setup"; break; }
            if (visible(document.querySelector("#login-form"))) { mode = "login"; break; }
            await sleep(500);
          }
          // 2. 全新库：填口令提交，走完设置流程
          let submitted = false;
          if (mode === "setup") {
            const form = document.querySelector("#setup-form");
            form.querySelector('[name="password"]').value = "smoke-test-pass-123";
            form.querySelector('[name="password2"]').value = "smoke-test-pass-123";
            form.requestSubmit();
            submitted = true;
          }
          // 3. 等应用壳出现且看板有内容
          let pageChildren = 0;
          let appVisible = false;
          for (let i = 0; i < 40; i++) {
            appVisible = visible(document.querySelector("#app-view"));
            const page = document.querySelector("#page");
            pageChildren = page ? page.children.length : 0;
            if (appVisible && pageChildren > 0) break;
            await sleep(500);
          }
          const h = await fetch("/api/v1/health").then(r => r.json()).catch(e => ({ error: String(e) }));
          return { title: document.title, hasApp: !!document.querySelector("#app"), mode, submitted, appVisible, pageChildren, health: h };
        })()`,
      )) as Record<string, unknown>;
      clearTimeout(timer);
      log("smoke info", JSON.stringify(info));
      const ok =
        info.title &&
        info.hasApp === true &&
        (info.health as { ok?: boolean } | undefined)?.ok === true &&
        (info.mode === "login" ||
          (info.mode === "setup" &&
            info.submitted === true &&
            info.appVisible === true &&
            (info.pageChildren as number) > 0));
      if (ok) {
        console.log("SMOKE OK");
        app.exit(0);
      } else {
        console.log("SMOKE FAIL: bad state");
        app.exit(1);
      }
    } catch (e) {
      clearTimeout(timer);
      console.log("SMOKE FAIL:", String(e));
      app.exit(1);
    }
  }
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "监控账号工作台",
      submenu: [
        {
          label: "检查更新",
          click: () => void checkForUpdates(true),
        },
        { type: "separator" },
        {
          label: "关于",
          click: () => {
            void dialog.showMessageBox({
              type: "info",
              title: "关于",
              message: `监控账号工作台 v${app.getVersion()}`,
              detail: "视频与文件全部存在本机。每天 8:00（北京时间）自动采集需程序开着。",
            });
          },
        },
        { type: "separator" },
        isMac ? { role: "quit", label: "退出" } : { role: "quit", label: "退出" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "forceReload", label: "强制重新加载" },
        { type: "separator" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "close", label: "关闭窗口" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "打开数据目录",
          click: () => {
            void shell.openPath(dataDir());
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function checkForUpdates(manual: boolean): Promise<void> {
  if (!app.isPackaged) {
    if (manual) {
      await dialog.showMessageBox({
        type: "info",
        title: "检查更新",
        message: "开发模式不检查更新（更新源只在打包后的程序里生效）。",
      });
    }
    return;
  }
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  if (manual) manualCheckPending = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    log("checkForUpdates failed", e);
    if (manual) {
      await dialog.showMessageBox({
        type: "warning",
        title: "检查更新",
        message: `检查更新失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  } finally {
    updateCheckInFlight = false;
  }
}

function setupUpdater(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on("checking-for-update", () => log("updater: checking"));
  autoUpdater.on("update-available", (info) => log("updater: available", info.version));
  autoUpdater.on("update-not-available", () => {
    log("updater: not available");
    if (!manualCheckPending) return; // 静默检查不弹窗
    manualCheckPending = false;
    void dialog.showMessageBox({
      type: "info",
      title: "检查更新",
      message: "已是最新版。",
    });
  });
  autoUpdater.on("download-progress", (p) => log("updater: progress", Math.round(p.percent) + "%"));
  autoUpdater.on("update-downloaded", async (info) => {
    log("updater: downloaded", info.version);
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "更新已下载",
      message: `新版本 ${info.version} 已下载好，现在重启安装吗？`,
      buttons: ["现在重启", "稍后"],
      defaultId: 0,
    });
    if (response === 0) autoUpdater.quitAndInstall(false, true);
  });
  autoUpdater.on("error", (err) => log("updater: error", err.message));
}

async function boot(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  await app.whenReady();
  buildMenu();
  setupUpdater();

  try {
    running = await startLocalServer({ dataDir: dataDir(), port: 0 });
    log("server up", running.url);
  } catch (e) {
    log("server failed", e);
    await dialog.showErrorBox(
      "启动失败",
      `本地服务启动失败，程序无法运行。\n${e instanceof Error ? e.message : String(e)}`,
    );
    app.quit();
    return;
  }

  await createWindow(running.url);

  if (app.isPackaged && !SMOKE) {
    // 启动后 10 秒静默查一次更新（不打扰打开）
    setTimeout(() => void checkForUpdates(false), 10_000);
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null && running) void createWindow(running.url);
});

app.on("before-quit", () => {
  if (running) {
    const r = running;
    running = null;
    void r.close().catch((e: unknown) => log("server close failed", e));
  }
});

// 调试用：数据目录写进日志（不含任何密钥）
log("data dir:", dataDir());
void boot().catch((e: unknown) => {
  console.error("boot failed", e);
  app.quit();
});

export {};
