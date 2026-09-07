const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell } = require('electron');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

app.setName('Daylight');
const root = path.join(__dirname, '..');
const importLocal = file => import(pathToFileURL(path.join(root, file)).href);
let mainWindow, tray, server, quitting = false, endpoint, token, trayTimer;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => { /* Keep the menu bar and local API running. */ });
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(trayTimer);
    tray?.destroy();
    server?.close();
  });

  app.whenReady().then(async () => {
    const { createWorkbench } = await importLocal('server.mjs');
    const { defaultDataDir } = await importLocal('storage.mjs');
    const { localDate } = await importLocal('public/model.js');
    const { getTrayState } = await importLocal('desktop/tray-model.mjs');
    const dataDir = process.env.WORKBENCH_DATA_DIR || defaultDataDir;
    server = await createWorkbench({ dataDir });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(process.env.PORT || 4318), '127.0.0.1', resolve);
    });
    endpoint = `http://127.0.0.1:${server.address().port}`;
    token = (await readFile(path.join(dataDir, 'agent-token'), 'utf8')).trim();

    const image = nativeImage.createFromPath(path.join(root, 'build', 'trayTemplate.png'));
    image.setTemplateImage(true);
    tray = new Tray(image);
    async function apply(action, expectedVersion) {
      try {
        const response = await fetch(`${endpoint}/api/v1/actions`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: randomUUID(), expectedVersion, action }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
      } catch (error) {
        dialog.showMessageBox({ type: 'warning', title: '任务未更新', message: '无法更新任务', detail: error.message });
      }
    }
    function updateTray() {
      if (!tray || tray.isDestroyed()) return;
      const { version, state } = server.getSnapshot();
      const { pending, today, other } = getTrayState(state, localDate());
      tray.setTitle(`待办 ${pending.length}`);
      tray.setToolTip(`Daylight · 今日 ${today.length} 项 · 全部待办 ${pending.length} 项`);
      const taskItem = task => ({
        label: `${task.status === 'active' ? '▶ ' : ''}${task.title}`,
        submenu: [
          { label: state.projects.find(project => project.id === task.projectId)?.name || '收件箱', enabled: false },
          { type: 'separator' },
          { label: '标记完成', click: () => apply({ type: 'task.status', id: task.id, status: 'done' }, version) },
          { label: task.status === 'active' ? '暂停任务' : '开始任务', click: () => apply({ type: 'task.status', id: task.id, status: task.status === 'active' ? 'todo' : 'active' }, version) },
          { label: today.some(item => item.id === task.id) ? '移出今天' : '加入今天', click: () => apply({ type: today.some(item => item.id === task.id) ? 'plan.remove' : 'plan.add', id: task.id }, version) },
          { label: '查看任务', click: () => showWindow(`task=${encodeURIComponent(task.id)}`) },
        ],
      });
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: `今日任务 · ${today.length}`, enabled: false },
        ...(today.length ? today.slice(0, 8).map(taskItem) : [{ label: '今天暂无安排', enabled: false }]),
        ...(today.length > 8 ? [{ label: `查看全部 ${today.length} 项今日任务…`, click: () => showWindow('today') }] : []),
        { type: 'separator' },
        { label: `其他待办 · ${other.length}`, enabled: false },
        ...other.slice(0, 8).map(taskItem),
        ...(!pending.length ? [{ label: '暂无待办任务', enabled: false }] : []),
        ...(other.length > 8 ? [{ label: `查看全部待办…`, click: () => showWindow('all') }] : []),
        { type: 'separator' },
        { label: '新建任务…', accelerator: 'CommandOrControl+N', click: () => showWindow('new') },
        { label: '打开工作台', click: () => showWindow('today') },
        { label: '打开数据目录', click: () => shell.openPath(dataDir) },
        { type: 'separator' },
        { label: '退出 Daylight', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
      ]));
    }
    server.on('state-changed', updateTray);
    trayTimer = setInterval(updateTray, 30000);
    updateTray();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Daylight', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { label: '文件', submenu: [{ label: '新建任务', accelerator: 'CommandOrControl+N', click: () => showWindow('new') }, { role: 'close' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { label: '显示工作台', click: () => showWindow('today') }] },
    ]));
    showWindow();
  }).catch(error => {
    dialog.showErrorBox('Daylight 无法启动', error.code === 'EADDRINUSE' ? '本地端口已被占用。请先停止正在运行的网页开发服务，再启动 Daylight。数据不会被删除。' : error.message);
    app.quit();
  });
}

function showWindow(route) {
  if (!endpoint) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = new BrowserWindow({
      width: 1240, height: 820, minWidth: 760, minHeight: 560, show: false,
      title: 'Daylight · 任务管理', backgroundColor: '#f7f8f5',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== endpoint) event.preventDefault();
    });
    mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    mainWindow.on('close', event => {
      if (!quitting) { event.preventDefault(); mainWindow.hide(); }
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.loadURL(endpoint + '/' + (route ? `#${route}` : ''));
  } else if (route) {
    // A same-document hash navigation preserves drafts and needs no preload bridge.
    const target = `${endpoint}/#${route}&intent=${randomUUID()}`;
    if (mainWindow.webContents.getURL() !== target) mainWindow.loadURL(target);
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
