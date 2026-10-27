// Real Electron renderer smoke test. No message is sent and no model is invoked.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gravbot-ui-'));
process.env.GRAV_BOT_DATA_DIR = path.join(data, 'studio');
process.env.GRAV_BOT_SMOKE_TEST = '1';
app.setPath('userData', path.join(data, 'electron'));
app.setPath('logs', path.join(data, 'logs'));
app.disableHardwareAcceleration();
const errors = [];
const timer = setTimeout(() => { console.error('Renderer smoke test timed out'); app.exit(1); }, 20000);
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, level, message) => {
    if (level === 3 && !message.includes('Electron Security Warning')) errors.push(message);
  });
  contents.on('did-finish-load', async () => {
    try {
      // Wait for the renderer's initial IPC state fetch, without sending messages.
      let report;
      for (let i = 0; i < 30; i++) {
        report = await contents.executeJavaScript(`({ title: document.title, seats: document.querySelectorAll('.roster-item').length, avatars: document.querySelectorAll('.roster-item svg').length, primary: document.getElementById('activeSeatName')?.textContent, body: document.body.scrollWidth, viewport: innerWidth })`);
        if (report.seats === 21) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (report.seats !== 21 || !report.avatars || errors.length) throw Error(JSON.stringify({ report, errors }));
      const screenshot = path.join(data, 'preview.png');
      fs.writeFileSync(screenshot, (await contents.capturePage()).toPNG());
      console.log(JSON.stringify({ ok: true, report, screenshot, modelCalls: 0 }));
      clearTimeout(timer);
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error);
      clearTimeout(timer);
      app.exit(1);
    }
  });
});
require('../main.js');
