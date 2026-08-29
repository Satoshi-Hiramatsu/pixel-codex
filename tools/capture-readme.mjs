import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const scenes = {
  office: {
    output: 'docs/screenshots/office-command-center.png',
    ready: '.office-canvas canvas',
    setup: `
      document.querySelector('[aria-label="明細を閉じる"]')?.click();
      document.querySelector('[aria-label="会計報告を閉じる"]')?.click();
    `,
  },
  accounting: {
    output: 'docs/screenshots/accounting-report.png',
    ready: '#payroll-title',
    setup: `
      document.querySelector('.hud-payroll')?.click();
      await new Promise((resolve) => setTimeout(resolve, 250));

      const amount = document.querySelector('.payroll-hero-amount');
      if (amount) amount.innerHTML = '<i>￥</i>428<em>.64</em><b>円</b>';
      const note = document.querySelector('.payroll-hero-note');
      if (note) note.textContent = '821.8K トークン働きました（README用デモデータ）';

      const moneyTable = document.querySelectorAll('.payroll-table')[0];
      const moneyRows = moneyTable?.querySelectorAll('tbody tr');
      const demoUsage = [
        ['420,000', '￥81.38'],
        ['180,000', '￥3.49'],
        ['221,792', '￥343.78'],
      ];
      moneyRows?.forEach((row, index) => {
        const cells = row.querySelectorAll('td');
        if (cells[1]) cells[1].textContent = demoUsage[index][0];
        if (cells[3]) cells[3].textContent = demoUsage[index][1];
      });
      const totalCells = moneyTable?.querySelectorAll('tfoot td');
      if (totalCells?.[1]) totalCells[1].textContent = '821,792';
      if (totalCells?.[3]) totalCells[3].textContent = '￥428.64';

      const agentList = document.querySelector('.payroll-agent-list');
      if (agentList) agentList.innerHTML = [
        ['#d9973f', '東葛大五郎', '284.1K', 100, '￥148.20'],
        ['#65b7d8', '企画一郎', '176.4K', 65, '￥96.44'],
        ['#e1775b', '組立実', '252.0K', 90, '￥132.80'],
        ['#78b56c', '試験守', '109.3K', 35, '￥51.20'],
      ].map(([color, name, tokens, width, yen]) =>
        '<div class="payroll-agent">' +
          '<span class="payroll-agent-chip" style="background:' + color + '"></span>' +
          '<div class="payroll-agent-copy"><strong>' + name + '</strong><small>' + tokens + ' トークン</small></div>' +
          '<div class="payroll-agent-bar"><i style="width:' + width + '%"></i></div>' +
          '<b>' + yen + '</b>' +
        '</div>').join('');

      const compareRows = document.querySelectorAll('.payroll-table')[1]?.querySelectorAll('tbody tr');
      ['￥428.64', '￥390.12', '￥96.78'].forEach((value, index) => {
        const cell = compareRows?.[index]?.querySelectorAll('td')[2];
        if (cell) cell.textContent = value;
      });
    `,
  },
};

const sceneName = process.argv[2];
const scene = scenes[sceneName];

if (!scene) {
  console.error(`Usage: node tools/capture-readme.mjs <${Object.keys(scenes).join('|')}>`);
  process.exit(1);
}

const endpoint = process.env.PIXEL_CODEX_CDP ?? 'http://127.0.0.1:9333/json';
const targets = await fetch(endpoint).then((response) => {
  if (!response.ok) throw new Error(`CDP target list failed: ${response.status}`);
  return response.json();
});
const target = targets.find((entry) => entry.type === 'page' && entry.title === 'Pixel Codex');

if (!target?.webSocketDebuggerUrl) {
  throw new Error('Pixel Codex was not found. Start it with: npm start -- -- --remote-debugging-port=9333');
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});

let requestId = 0;
const pending = new Map();
socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function send(method, params = {}) {
  const id = ++requestId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression, awaitPromise = true) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Renderer evaluation failed');
  }
  return result.result?.value;
}

async function waitForSelector(selector, timeoutMs = 15_000) {
  const encoded = JSON.stringify(selector);
  await evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + ${timeoutMs};
    const check = () => {
      if (document.querySelector(${encoded})) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for ${selector}'));
      setTimeout(check, 100);
    };
    check();
  })`);
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await waitForSelector('.office-canvas canvas');
  await evaluate(`(async () => {
    await document.fonts.ready;
    const style = document.createElement('style');
    style.dataset.readmeCapture = 'true';
    style.textContent = '* { animation: none !important; transition: none !important; caret-color: transparent !important; }';
    document.head.appendChild(style);
    const workspace = document.querySelector('.workspace-button strong');
    if (workspace) {
      workspace.textContent = 'C:\\\\dev\\\\pixel-codex-demo';
      workspace.title = 'C:\\\\dev\\\\pixel-codex-demo';
    }
    const reportCount = document.querySelector('.report-button strong');
    if (reportCount) reportCount.textContent = '3';
    ${scene.setup}
    await new Promise((resolve) => setTimeout(resolve, 900));
  })()`);
  await waitForSelector(scene.ready);

  const screenshot = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const destination = path.resolve(scene.output);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, Buffer.from(screenshot.data, 'base64'));
  console.log(`${sceneName}: ${scene.output}`);
} finally {
  socket.close();
}
