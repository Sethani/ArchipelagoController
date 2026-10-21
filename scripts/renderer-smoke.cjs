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
  await send('Runtime.evaluate', { expression: `(() => { const drawer=document.querySelector('.console-drawer'); if (drawer && !drawer.classList.contains('open')) drawer.querySelector('.drawer-toggle')?.click(); })()` });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (process.argv.includes('--long-console')) {
    await send('Runtime.evaluate', { expression: `(() => { const output=document.querySelector('.console-output'); if (!output) return; const line=document.createElement('span'); line.className='message'; line.dataset.smokeLongLine='true'; line.textContent='LONG_'+('X'.repeat(20000)); output.appendChild(line); })()` });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (process.argv.includes('--resize-layout')) {
    await send('Runtime.evaluate', { expression: `(() => {
      window.__smokeLayout = { sidebarStorage: localStorage.getItem('archipelago-controller-sidebar-width'), consoleStorage: localStorage.getItem('archipelago-controller-console-height'), sidebarBefore: document.querySelector('.nav-rail')?.getBoundingClientRect().width || 0, consoleBefore: document.querySelector('.console-drawer')?.getBoundingClientRect().height || 0 };
      const side=document.querySelector('.sidebar-resizer'); const sideRect=side?.getBoundingClientRect();
      if (side && sideRect) { side.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:sideRect.left})); window.dispatchEvent(new PointerEvent('pointermove',{clientX:sideRect.left+32})); window.dispatchEvent(new PointerEvent('pointerup',{clientX:sideRect.left+32})); }
      const consoleHandle=document.querySelector('.console-resizer'); const consoleRect=consoleHandle?.getBoundingClientRect();
      if (consoleHandle && consoleRect) { consoleHandle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientY:consoleRect.top})); window.dispatchEvent(new PointerEvent('pointermove',{clientY:consoleRect.top-60})); window.dispatchEvent(new PointerEvent('pointerup',{clientY:consoleRect.top-60})); }
    })()` });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (process.argv.includes('--seed-local-room')) {
    await send('Runtime.evaluate', { expression: `(() => { const key='archipelago-controller-state-v1'; const state=JSON.parse(localStorage.getItem(key)||'{}'); const now=new Date().toISOString(); const slots=[{slot:1,name:'Sethiduck_V',game:'VVVVVV',mine:true,downloadAvailable:true,files:[{id:'smoke-file',name:'Sethiduck_V.apvvv',path:'C:\\\\games\\\\archipelago\\\\Rooms\\\\Smoke_local-smoke\\\\downloads\\\\Sethiduck_V\\\\Sethiduck_V.apvvv',kind:'downloaded',size:8192,modifiedAt:now}]}]; state.rooms=[{id:'local-smoke-room',label:'Game Night',url:'local://room/local-smoke-room',folderPath:'C:\\\\games\\\\archipelago\\\\Rooms\\\\Smoke_local-smoke',createdAt:now,passwordSet:false,autoLoginWarningAccepted:false,provider:{type:'local',historyRunId:'smoke-run'},slots,status:{lastPort:38281,refreshedAt:now,stale:false},hosted:{historyRunId:'smoke-run',sessionPath:'C:\\\\games\\\\archipelago\\\\Smoke',advertisedHost:'games.example.test',gamePort:38281,portalPort:38282,publicBaseUrl:'',automaticPortMapping:true,insecureHttpAccepted:true,sharedSlots:[1],accessTokenSet:false,shareStatus:{state:'offline',serverRunning:false,portalRunning:false,mapping:'unknown',reachability:'unknown'}}},...(state.rooms||[]).filter(room=>room.id!=='local-smoke-room')]; localStorage.setItem(key,JSON.stringify(state)); })()` });
    await send('Page.reload', { ignoreCache: true });
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
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
  if (process.argv.includes('--rooms')) {
    await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.nav-rail nav button')].find((button) => button.textContent.includes('Rooms'))?.click()` });
    await new Promise((resolve) => setTimeout(resolve, 12000));
    if (process.argv.includes('--official-room')) {
      await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.room-list > button')].find((button) => button.textContent.includes('archipelago.gg'))?.click()` });
      await new Promise((resolve) => setTimeout(resolve, 12000));
    }
    if (process.argv.includes('--hints')) {
      await send('Runtime.evaluate', { expression: `document.querySelector('.room-live-tabs button:nth-child(2)')?.click()` });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (process.argv.includes('--launch-ut-mf')) {
      await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.room-progress-row')].find((row) => row.textContent.includes('Metroid Fusion'))?.querySelector('.text-button')?.click()` });
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    if (process.argv.includes('--analyze-ut-mf')) {
      await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.room-progress-row')].find((row) => row.textContent.includes('Metroid Fusion'))?.querySelector('.room-logic-actions .text-button')?.click()` });
      for (let attempt = 0; attempt < 180; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const value = await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.room-progress-row')].find((row) => row.textContent.includes('Metroid Fusion'))?.querySelector('.room-logic-counts')?.textContent || ''`, returnByValue: true });
        if (value.result.result.value) break;
      }
    }
    if (process.argv.includes('--launch-setup')) {
      await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.room-start-button')].find((button) => button.textContent.includes('Set up'))?.click()` });
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
      ,roomsView: Boolean(document.querySelector('.rooms-view'))
      ,roomRows: document.querySelectorAll('.room-slot-row').length
      ,launchEditor: Boolean(document.querySelector('.room-launch-config'))
      ,launchEditorOverflow: (() => { const editor = document.querySelector('.room-launch-config'); return Boolean(editor && editor.scrollWidth > editor.clientWidth + 1); })()
      ,gameLaunchProfiles: (() => { try { return JSON.parse(localStorage.getItem('archipelago-controller-state-v1') || '{}').gameLaunchProfiles || {}; } catch { return {}; } })()
      ,roomClientButtons: [...document.querySelectorAll('.room-client-button')].map((button) => button.textContent.trim())
      ,internetHosting: Boolean(document.querySelector('.internet-hosting'))
      ,internetHostingOverflow: (() => { const panel=document.querySelector('.internet-hosting'); return Boolean(panel && panel.scrollWidth > panel.clientWidth + 1); })()
      ,roomProgressRows: document.querySelectorAll('.room-progress-row').length
      ,roomHintCount: document.querySelector('.room-live-tabs button:nth-child(2)')?.textContent || ''
      ,roomLogicCounts: [...document.querySelectorAll('.room-logic-counts')].map((item) => item.textContent.trim())
      ,consoleHorizontalOverflow: (() => { const output=document.querySelector('.console-output'); return Boolean(output && output.scrollWidth > output.clientWidth + 1); })()
      ,shellWidthStable: document.querySelector('.app-shell')?.getBoundingClientRect().width <= window.innerWidth + 1
      ,layoutResize: window.__smokeLayout ? { sidebarDelta: (document.querySelector('.nav-rail')?.getBoundingClientRect().width || 0)-window.__smokeLayout.sidebarBefore, consoleDelta: (document.querySelector('.console-drawer')?.getBoundingClientRect().height || 0)-window.__smokeLayout.consoleBefore } : null
    })`,
    returnByValue: true,
  });
  const result = JSON.parse(evaluation.result.result.value);
  console.log(JSON.stringify(result));
  if (!result.consoleDrawer || !result.consoleInput || !result.activityTab || result.horizontalOverflow) process.exitCode = 2;
  if (process.argv.includes('--apworlds') && (!result.apworldManager || result.apworldDetailOverlap)) process.exitCode = 2;
  if (process.argv.includes('--rooms') && (!result.roomsView || result.launchEditorOverflow)) process.exitCode = 2;
  if (process.argv.includes('--seed-local-room') && (!result.internetHosting || result.internetHostingOverflow)) process.exitCode = 2;
  if (process.argv.includes('--long-console') && (result.consoleHorizontalOverflow || !result.shellWidthStable)) process.exitCode = 2;
  if (process.argv.includes('--resize-layout') && (!result.layoutResize || result.layoutResize.sidebarDelta < 20 || result.layoutResize.consoleDelta < 40)) process.exitCode = 2;
  if (process.argv.includes('--screenshot')) {
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    const target = path.join(os.tmpdir(), 'archipelago-controller-renderer.png');
    fs.writeFileSync(target, Buffer.from(screenshot.result.data, 'base64'));
    console.log(target);
  }
  if (process.argv.includes('--resize-layout')) await send('Runtime.evaluate', { expression: `(() => { const saved=window.__smokeLayout; if (!saved) return; if (saved.sidebarStorage === null) localStorage.removeItem('archipelago-controller-sidebar-width'); else localStorage.setItem('archipelago-controller-sidebar-width', saved.sidebarStorage); if (saved.consoleStorage === null) localStorage.removeItem('archipelago-controller-console-height'); else localStorage.setItem('archipelago-controller-console-height', saved.consoleStorage); })()` });
  socket.close();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
