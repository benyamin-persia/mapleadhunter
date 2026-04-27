'use strict';
// Must clear ELECTRON_RUN_AS_NODE — it's set by some environments (Claude Code, tsx, etc.)
// and causes Electron to run as plain Node.js, breaking all Electron APIs
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } = require('electron');
const { get }   = require('http');
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

const PORT     = Number(process.env.PORT || 3000);
const IS_DEV   = !app.isPackaged;
const APP_ROOT = IS_DEV
  ? __dirname
  : path.join(process.resourcesPath, 'app');

let win      = null;
let tray     = null;
let server   = null;

// ── Log file ──────────────────────────────────────────────────────────────────
let logStream = null;
function openLog() {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'app.log');
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  logStream.write('\n\n=== ' + new Date().toISOString() + ' — app started ===\n');
  console.log('[log] writing to', logFile);
}
function log(line) {
  process.stdout.write(line);
  if (logStream) logStream.write(line);
}
let splash   = null;
let quitting = false;

// ── Load .env ─────────────────────────────────────────────────────────────────
function loadEnv() {
  const envFile = path.join(APP_ROOT, '.env');
  const env = Object.assign({}, process.env, { PORT: String(PORT) });
  delete env.ELECTRON_RUN_AS_NODE; // prevent child process from running as Node
  if (!fs.existsSync(envFile)) return env;
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(function(line) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
  return env;
}

// ── Start Express server ──────────────────────────────────────────────────────
function startServer() {
  const env   = loadEnv();
  const entry = path.join(APP_ROOT, 'src', 'server', 'index.ts');

  if (IS_DEV) {
    // Dev: tsx resolves via shell PATH (tsx.cmd in node_modules/.bin, shell finds it)
    server = spawn('tsx', [entry], {
      cwd: APP_ROOT, env: env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    // Prod: use Electron's own bundled Node.js to run tsx — no separate Node.js install needed.
    // ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave as plain Node.js.
    const tsxCli = path.join(APP_ROOT, 'node_modules', 'tsx', 'dist', 'cli.cjs');
    const serverEnv = Object.assign({}, env, { ELECTRON_RUN_AS_NODE: '1' });
    server = spawn(process.execPath, [tsxCli, entry], {
      cwd: APP_ROOT, env: serverEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  server.stdout.on('data', function(d) { log('[server] ' + d); });
  server.stderr.on('data', function(d) { log('[server:err] ' + d); });
  server.on('exit', function(code) {
    if (!quitting)
      dialog.showErrorBox('Server stopped', 'The server exited (code ' + code + '). Restart the app.');
  });
}

// ── Wait for server ───────────────────────────────────────────────────────────
function waitForServer(timeout) {
  timeout = timeout || 60000;
  return new Promise(function(resolve, reject) {
    const deadline = Date.now() + timeout;
    function check() {
      get('http://localhost:' + PORT, function(res) {
        res.resume();
        if (res.statusCode < 500) resolve();
        else retry();
      }).on('error', retry);
    }
    function retry() {
      if (Date.now() > deadline) reject(new Error('Server did not start in 60s'));
      else setTimeout(check, 700);
    }
    check();
  });
}

// ── Splash screen ─────────────────────────────────────────────────────────────
function showSplash() {
  splash = new BrowserWindow({
    width: 400, height: 240, frame: false,
    alwaysOnTop: true, resizable: false,
    webPreferences: { nodeIntegration: false },
  });
  splash.loadURL('data:text/html,' + encodeURIComponent([
    '<!DOCTYPE html><html><body style="margin:0;background:#1e293b;display:flex;',
    'flex-direction:column;align-items:center;justify-content:center;',
    'height:100vh;font-family:system-ui,sans-serif;color:#e2e8f0">',
    '<div style="font-size:28px;font-weight:700">MapLead<span style="color:#818cf8">Hunter</span></div>',
    '<div style="margin-top:12px;font-size:13px;color:#64748b">Starting server...</div>',
    '<div style="margin-top:24px;width:220px;height:4px;background:#334155;border-radius:4px;overflow:hidden">',
    '<div id="b" style="height:100%;width:0%;background:#818cf8;border-radius:4px;transition:width 0.4s"></div></div>',
    '<script>var p=0;setInterval(function(){p=Math.min(p+2,90);',
    'document.getElementById("b").style.width=p+"%"},300)</script>',
    '</body></html>'
  ].join('')));
}

// ── Main window ───────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: 'MapLeadHunter', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL('http://localhost:' + PORT);
  win.once('ready-to-show', function() {
    if (splash) { splash.destroy(); splash = null; }
    win.show(); win.focus();
  });
  win.on('close', function(e) {
    if (quitting) return;
    e.preventDefault();
    // Ask if user wants to sync to Google Sheets before hiding
    const hasSheets = !!(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (!hasSheets) { win.hide(); return; }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Sync to Google Sheets', 'Just Hide', 'Cancel'],
      defaultId: 0,
      title: 'Before you go',
      message: 'Do you want to update Google Sheets before hiding?',
    });
    if (choice === 0) {
      // Trigger sheets backup then hide
      const { get, request } = require('http');
      const req = request({ hostname: 'localhost', port: PORT, path: '/api/backup/sheets', method: 'POST',
        headers: { 'Content-Type': 'application/json' } }, function(res) {
        res.resume();
        win.hide();
      });
      req.on('error', function() { win.hide(); });
      req.end();
    } else if (choice === 1) {
      win.hide();
    }
    // choice === 2: Cancel — do nothing
  });
  win.webContents.setWindowOpenHandler(function(details) {
    shell.openExternal(details.url); return { action: 'deny' };
  });
}

// ── System tray ───────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'electron', 'icon.png');
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('MapLeadHunter');
  tray.on('click', function() { if (win) { win.show(); win.focus(); } });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open MapLeadHunter', click: function() { if (win) { win.show(); win.focus(); } } },
    { label: 'Open in Browser',    click: function() { shell.openExternal('http://localhost:' + PORT); } },
    { label: 'View Logs',          click: function() { shell.openPath(path.join(app.getPath('userData'), 'logs', 'app.log')); } },
    { type: 'separator' },
    { label: 'Quit', click: function() { quitting = true; if (server) server.kill(); app.quit(); } },
  ]));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
app.whenReady().then(function() {
  openLog();
  showSplash();
  startServer();
  waitForServer().then(function() {
    createWindow();
    createTray();
  }).catch(function(err) {
    dialog.showErrorBox('Startup failed', String(err));
    app.quit();
  });
});

app.on('window-all-closed', function(e) { e.preventDefault(); }); // keep in tray
app.on('before-quit', function() { quitting = true; if (server) server.kill(); });
app.on('activate', function() { if (win) { win.show(); win.focus(); } });
