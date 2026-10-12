const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = process.argv[2] || '9223';

async function main() {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find((entry) => entry.type === 'page');
  if (!page) throw new Error('No renderer page found.');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') console.error(`RENDERER_EXCEPTION ${message.params.exceptionDetails.text}: ${message.params.exceptionDetails.exception?.description ?? ''}`);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') console.error(`RENDERER_CONSOLE ${message.params.args.map((arg) => arg.value ?? arg.description).join(' ')}`);
    if (!message.id || !pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (process.argv.includes('--roster')) {
    await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.nav-rail nav button')].find((button) => button.textContent.includes('Player Roster'))?.click()` });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (process.argv.includes('--library')) {
    await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.nav-rail nav button')].find((button) => button.textContent.includes('Template Library'))?.click()` });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (process.argv.includes('--validate-first')) {
      await send('Runtime.evaluate', { expression: `document.querySelector('.table-row button[title^="Validate "]')?.click()` });
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const status = await send('Runtime.evaluate', { expression: `document.querySelector('.template-statuses')?.textContent || ''`, returnByValue: true });
        const text = status.result.result.value || '';
        if (/Valid|Rejected|Generator failed|Timed out|Cancelled|Stale/.test(text) && !/Checking options/.test(text)) break;
      }
    }
    if (process.argv.includes('--validate-invalid')) {
      await send('Runtime.evaluate', {
        expression: `(async () => { const state = JSON.parse(localStorage.getItem('archipelago-controller-state-v1')); const item = state.templates[0]; window.__invalidValidation = await window.archipelago.validateYamls({ installRoot: state.settings.installRoot, templates: [{ id: 'smoke-invalid', fileName: 'SmokeInvalid.yaml', content: item.content + '\\ndefinitely_not_an_option: true\\n' }] }); return window.__invalidValidation; })()`,
        awaitPromise: true,
        returnByValue: true,
      });
    }
  }
  if (process.argv.includes('--apworlds')) {
    await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.nav-rail nav button')].find((button) => button.textContent.includes('APWorlds'))?.click()` });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (process.argv.includes('--refresh-worlds')) {
      await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.apworld-heading button')].find((button) => button.textContent.includes('Refresh'))?.click()` });
      await new Promise((resolve) => setTimeout(resolve, 7000));
    }
    if (process.argv.includes('--apworld-catalog')) {
      await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.apworld-tabs button')].find((button) => button.textContent.includes('Catalog'))?.click()` });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await send('Runtime.evaluate', { expression: `document.querySelector('.apworld-table-row')?.click()` });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  const evaluation = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title,
      consoleDrawer: Boolean(document.querySelector('.console-drawer')),
      consoleInput: Boolean(document.querySelector('.console-input input')),
      activityTab: [...document.querySelectorAll('.console-tabs button')].some((button) => button.textContent === 'Activity'),
      background: getComputedStyle(document.body).backgroundColor,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      rosterCards: [...document.querySelectorAll('.roster-card')].map((card) => ({ top: card.getBoundingClientRect().top, height: card.getBoundingClientRect().height })),
      consoleActions: [...document.querySelectorAll('.console-actions button')].map((button) => button.textContent.trim())
      ,apworldManager: Boolean(document.querySelector('.apworlds-view'))
      ,apworldRows: document.querySelectorAll('.apworld-table-row').length
      ,apworldDetailOverlap: (() => { const list = document.querySelector('.apworld-list-pane')?.getBoundingClientRect(); const detail = document.querySelector('.apworld-detail')?.getBoundingClientRect(); return Boolean(list && detail && list.right > detail.left + 1); })()
      ,apworldTabs: [...document.querySelectorAll('.apworld-tabs button')].map((button) => button.textContent.trim())
      ,apworldSources: [...document.querySelectorAll('.apworld-sourcebar > span')].map((item) => item.textContent.trim())
      ,apworldDetail: document.querySelector('.apworld-detail')?.textContent.slice(0, 120) || ''
      ,templateRows: document.querySelectorAll('.data-table .table-row').length
      ,templateStatuses: [...document.querySelectorAll('.template-statuses')].slice(0, 5).map((item) => item.textContent.trim())
      ,firstTemplateValidation: (() => { try { const state = JSON.parse(localStorage.getItem('archipelago-controller-state-v1')); const item = state.templates[0]; return { game: item.game, match: item.worldMatch?.signature, checked: item.apValidation?.worldSignature, fingerprint: item.apValidation?.fingerprint }; } catch { return null; } })()
      ,readiness: [...document.querySelectorAll('.readiness-row')].map((item) => item.textContent.trim())
      ,invalidValidation: window.__invalidValidation?.results?.[0]?.result?.status || ''
      ,invalidValidationOutput: window.__invalidValidation?.results?.[0]?.result?.output?.slice(-500) || ''
      ,invalidValidationWarnings: (window.__invalidValidation?.results?.[0]?.result?.output || '').split('\\n').filter((line) => /option|unknown|warning/i.test(line)).slice(0, 10)
    })`,
    returnByValue: true,
  });
  const result = JSON.parse(evaluation.result.result.value);
  console.log(JSON.stringify(result));
  if (!result.consoleDrawer || !result.consoleInput || !result.activityTab || result.horizontalOverflow) process.exitCode = 2;
  if (process.argv.includes('--apworlds') && (!result.apworldManager || result.apworldDetailOverlap)) process.exitCode = 2;
  if (process.argv.includes('--screenshot')) {
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    const target = path.join(os.tmpdir(), 'archipelago-controller-renderer.png');
    fs.writeFileSync(target, Buffer.from(screenshot.result.data, 'base64'));
    console.log(target);
  }
  socket.close();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
