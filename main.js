const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

let triggerWin = null;
let panelWin   = null;
let isVisible  = false;
let animating  = false;
let animTimer  = null;

// Trigger button dimensions
const TRIGGER_W_SLIM = 10;  // default: thin nearly-invisible strip
const TRIGGER_W_FULL = 52;  // hovered: full button
const TRIGGER_H      = 84;

const PANEL_RATIO = 0.30;

function getWorkArea() {
  return screen.getPrimaryDisplay().workArea;
}

function getPanelSize() {
  const wa = getWorkArea();
  return { PW: Math.round(wa.width * PANEL_RATIO), PH: wa.height, PY: wa.y };
}

function sendTrigger(state) {
  try {
    if (triggerWin && !triggerWin.isDestroyed()) {
      triggerWin.webContents.send("state", state);
    }
  } catch (e) {}
}

function stopAnim() {
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  animating = false;
}

function animateTo(targetX, duration, easeFn, onDone) {
  stopAnim();
  if (!panelWin || panelWin.isDestroyed()) { if (onDone) onDone(); return; }
  animating = true;
  const { PW, PH, PY } = getPanelSize();
  const [startX] = panelWin.getPosition();
  const intervalMs = Math.round(1000 / 60);
  const steps = Math.max(1, Math.round(duration / intervalMs));
  let step = 0;
  animTimer = setInterval(() => {
    if (!panelWin || panelWin.isDestroyed()) { stopAnim(); return; }
    step++;
    const t = Math.min(step / steps, 1);
    const x = Math.round(startX + (targetX - startX) * easeFn(t));
    panelWin.setBounds({ x, y: PY, width: PW, height: PH });
    if (step >= steps) { stopAnim(); if (onDone) onDone(); }
  }, intervalMs);
}

function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
function easeIn(t)  { return t * t * t; }

function doShow() {
  if (animating) return;
  if (!panelWin || panelWin.isDestroyed()) createPanelWindow();
  const { PW, PH, PY } = getPanelSize();
  const targetX = TRIGGER_W_FULL;
  isVisible = true;
  sendTrigger("open");
  panelWin.setBounds({ x: -(PW + 50), y: PY, width: PW, height: PH });
  if (!panelWin.isVisible()) panelWin.show();
  setTimeout(() => {
    if (!panelWin || panelWin.isDestroyed()) return;
    animateTo(targetX, 220, easeOut, () => {
      if (panelWin && !panelWin.isDestroyed()) panelWin.focus();
    });
  }, 20);
}

function doHide() {
  if (!panelWin || panelWin.isDestroyed() || !isVisible || animating) return;
  const { PW } = getPanelSize();
  const targetX = -(PW + 50);
  isVisible = false;
  sendTrigger("closed");
  animateTo(targetX, 180, easeIn, () => {
    if (panelWin && !panelWin.isDestroyed()) panelWin.hide();
  });
}

function toggle() {
  if (animating) return;
  if (isVisible) doHide(); else doShow();
}

function createPanelWindow() {
  const { PW, PH, PY } = getPanelSize();
  panelWin = new BrowserWindow({
    width: PW, height: PH,
    x: -(PW + 50), y: PY,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    resizable: false, movable: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  panelWin.loadFile(path.join(__dirname, "renderer", "index.html"));
  panelWin.setAlwaysOnTop(true, "screen-saver");
  panelWin.on("blur", () => {
    if (!isVisible || animating) return;
    setTimeout(() => {
      try {
        if (!panelWin || panelWin.isDestroyed() || !isVisible || animating) return;
        const trigFocused = triggerWin && !triggerWin.isDestroyed() && triggerWin.isFocused();
        if (!panelWin.isFocused() && !trigFocused) doHide();
      } catch (e) {}
    }, 120);
  });
  panelWin.on("closed", () => {
    panelWin = null; isVisible = false;
    stopAnim(); sendTrigger("closed");
  });
}

// ── Reposition trigger when display metrics change (F11, resolution change) ──
function reclampTrigger() {
  if (!triggerWin || triggerWin.isDestroyed()) return;
  const wa = getWorkArea();
  const b  = triggerWin.getBounds();
  // Clamp Y to stay within workArea
  const newY = Math.max(wa.y, Math.min(wa.y + wa.height - TRIGGER_H, b.y));
  triggerWin.setBounds({ x: 0, y: newY, width: b.width, height: TRIGGER_H });
}

app.whenReady().then(() => {
  const wa = getWorkArea();

  // Create trigger window — start slim
  triggerWin = new BrowserWindow({
    width: TRIGGER_W_SLIM,
    height: TRIGGER_H,
    x: 0,
    y: Math.floor(wa.height / 2 - TRIGGER_H / 2),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  triggerWin.setAlwaysOnTop(true, "screen-saver");
  triggerWin.loadFile(path.join(__dirname, "renderer", "trigger.html"));
  triggerWin.on("closed", () => { triggerWin = null; });

  createPanelWindow();

  // Fix trigger position on display changes (F11, resolution, DPI changes)
  screen.on("display-metrics-changed", () => { reclampTrigger(); });
  screen.on("display-added",           () => { reclampTrigger(); });
  screen.on("display-removed",         () => { reclampTrigger(); });
});

app.on("second-instance", () => { toggle(); });

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.on("toggle-panel", () => toggle());
ipcMain.on("close-app",    () => app.quit());

// Trigger hover: resize window between slim ↔ full
ipcMain.on("trigger-hover-in", () => {
  if (!triggerWin || triggerWin.isDestroyed()) return;
  const [, y] = triggerWin.getPosition();
  triggerWin.setBounds({ x: 0, y, width: TRIGGER_W_FULL, height: TRIGGER_H });
});
ipcMain.on("trigger-hover-out", () => {
  if (!triggerWin || triggerWin.isDestroyed()) return;
  const [, y] = triggerWin.getPosition();
  triggerWin.setBounds({ x: 0, y, width: TRIGGER_W_SLIM, height: TRIGGER_H });
});

ipcMain.on("move-trigger", (_, dy) => {
  if (!triggerWin || triggerWin.isDestroyed()) return;
  const wa = getWorkArea();
  const [, y] = triggerWin.getPosition();
  const newY = Math.max(wa.y, Math.min(wa.y + wa.height - TRIGGER_H, y + dy));
  triggerWin.setPosition(0, newY);
});

app.on("window-all-closed", () => { /* keep running */ });
