import { release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, globalShortcut, Menu, nativeTheme, session, shell } from 'electron';
import { loadState } from '../core/store.js';
import { APP_ID } from '../shared/config.js';
import { englishMessage } from '../shared/i18n/index.js';
import { AppController } from './controller.js';
import { configureSiteSessions, denyPermissions, sessionsToClear } from './browser.js';
import { registerIpc } from './ipc.js';
import { installFileLog } from './log.js';
import { clearSiteBrowsingData, waitForDataRemoval, wipeSiteDataOnDisk } from './privacy.js';
import { Updater } from './updater.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;

app.setName('WhimWatch');
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
// WSL's graphics (WSLg) lack the OpenGL ES 3 support Chromium's GPU process needs: it logs a burst of
// errors, exits, and Chromium falls back to software rendering anyway. Start with software rendering.
if (process.platform === 'linux' && (process.env.WSL_DISTRO_NAME || /microsoft/i.test(release()))) app.disableHardwareAcceleration();
// If "Remove all data" is still deleting the last run's folders, let it finish before Chromium opens them.
waitForDataRemoval(app.getPath('temp'));

const scanIndex = process.argv.indexOf('--scan');

if (process.argv.includes('--smoke')) {
  void app.whenReady().then(async () => {
    const { BrowserPool } = await import('./browser.js');
    const { runSmoke } = await import('./smoke.js');
    // --memory-sessions: the "forget sign-ins" setup, where nothing (not even Cloudflare clearance) is kept.
    if (process.argv.includes('--memory-sessions')) configureSiteSessions({ persist: false });
    const pool = new BrowserPool();
    const failures = await runSmoke(pool.fetcher());
    pool.dispose();
    app.exit(failures ? 1 : 0);
  });
} else if (scanIndex >= 0) {
  // Developer mode: full check of the given folders through the real browser, printed to stdout.
  void app.whenReady().then(async () => {
    const { BrowserPool } = await import('./browser.js');
    const { runCheck } = await import('../core/check.js');
    const { formatReport } = await import('../core/report.js');
    const pool = new BrowserPool();
    const dirs = process.argv.slice(scanIndex + 1).filter((a) => !a.startsWith('--'));
    const { result } = await runCheck({
      dirs,
      fetcher: pool.fetcher(),
      onProgress: (p) => p.phase !== 'scan' && process.stderr.write(`${p.phase} ${p.done}/${p.total} ${p.message}\n`),
    });
    console.log(formatReport(result));
    pool.dispose();
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | undefined;
  let relaunchRequested = false;

  app.on('second-instance', () => {
    // Still starting up: the window appears on its own.
    if (!mainWindow) return;
    if (mainWindow.isDestroyed()) {
      // The window is closed and WhimWatch is still quitting (e.g. clearing browsing data), so it can't
      // show anything. Open it again once this run has exited.
      if (!relaunchRequested) {
        relaunchRequested = true;
        // The portable build runs from a temporary copy that's removed on exit; restart the .exe itself.
        const portable = process.env.PORTABLE_EXECUTABLE_FILE;
        app.relaunch(portable ? { execPath: portable, args: [] } : undefined);
      }
      return;
    }
    // Also brings back a window put away with quick hide.
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => app.quit());

  void app.whenReady().then(async () => {
    // No Reload/DevTools menu in release builds. macOS still needs the app and Edit menus, or
    // Cmd+Q, Cmd+C/V (e.g. pasting a link) and Cmd+W stop working.
    if (app.isPackaged) {
      Menu.setApplicationMenu(
        process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null,
      );
    }
    // The app window needs no permissions or spellcheck downloads.
    denyPermissions(session.defaultSession);
    const userData = app.getPath('userData');
    installFileLog(app.getPath('logs'));
    const statePath = join(userData, 'state.json');
    {
      // Before any LoversLab/Patreon session exists, remove what they left on disk last time.
      const { settings } = await loadState(statePath);
      const forgetEverything = settings.clearBrowsingDataOnExit && settings.forgetSignInsOnExit;
      configureSiteSessions({ persist: !forgetEverything });
      if (settings.clearBrowsingDataOnExit) {
        await wipeSiteDataOnDisk(userData, !settings.forgetSignInsOnExit).catch((err: Error) => console.warn('Privacy cleanup failed:', englishMessage(err)));
      }
    }
    const controller = await AppController.create(statePath, join(userData, 'backups'));
    const updater = new Updater(controller, join(app.getPath('temp'), 'whimwatch'));
    controller.afterCheck = (result) => updater.autoInstall(result);
    controller.updatesBusy = () => updater.isBusy();
    controller.exclusive = (fn) => updater.runExclusive(fn);
    // Housekeeping before anything else can start an update.
    await updater.clearLeftoverDownloads().catch(() => undefined);
    await controller.pruneBackups().catch((err: Error) => console.warn('Backup cleanup failed:', englishMessage(err)));
    registerIpc(controller, updater, isTrustedUrl);

    controller.applyTheme();
    mainWindow = createWindow();
    controller.attachWindow(mainWindow);
    // The pool's hidden scraper windows are still windows, so window-all-closed doesn't fire while
    // one is cached — and nothing reaps them when a check succeeds, only when it's cancelled. That
    // left WhimWatch running with nothing on screen after a check, holding the single-instance lock
    // so it couldn't be started again: the report was having to end it in Task Manager to run the
    // next version. Closing the main window is the quit signal; quick hide uses hide(), not close.
    mainWindow.on('closed', () => app.quit());
    try {
      controller.applyQuickHide();
    } catch (err) {
      console.warn('Quick hide shortcut unavailable:', englishMessage(err));
    }
    app.on('will-quit', () => globalShortcut.unregisterAll());
    app.on('before-quit', () => {
      // Cancel first: a check whose pages are cut off from outside carries on with the next one, so
      // closing the windows alone left it opening new ones (and writing cookies) after the exit
      // clean-up, then saving a result full of errors over the last good one.
      controller.cancelCheck();
      controller.pool.dispose();
    });
    let cleared = false;
    app.on('will-quit', (event) => {
      const { clearBrowsingDataOnExit, forgetSignInsOnExit } = controller.currentState.settings;
      // Removing all data deletes these folders after exit anyway.
      if (cleared || !clearBrowsingDataOnExit || controller.removingData) return;
      event.preventDefault();
      cleared = true;
      // Never let a stuck cleanup keep WhimWatch running without a window (it holds the single-instance
      // lock, so it couldn't be opened again). The next launch removes leftovers from disk anyway.
      const giveUp = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      void Promise.race([
        clearSiteBrowsingData(sessionsToClear(), !forgetSignInsOnExit).catch((err: Error) => console.warn('Clearing browsing data failed:', englishMessage(err))),
        giveUp,
      ]).finally(() => app.quit());
    });

    mainWindow.webContents.once('did-finish-load', () => {
      void controller.maybeCheckOnLaunch();
      void controller.checkAppUpdate();
    });
  });
}

function isTrustedUrl(url: string): boolean {
  if (devServerUrl) return url.startsWith(devServerUrl);
  return url.startsWith('file://');
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'WhimWatch',
    // Matches the theme, so the window never flashes the wrong colour before the page paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0d13' : '#f7f6f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      spellcheck: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());

  // Links open in the user's browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });

  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(join(here, '../renderer/index.html'));
  return win;
}
