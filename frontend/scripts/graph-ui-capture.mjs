import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Observe actual GPU projection/viewport without replacing the renderer or its output.
export async function observeGraphRendering(context) {
  await context.addInitScript(() => {
    const names = new WeakMap(), projections = new WeakMap();
    const identities = new WeakMap(), traffic = [];
    let sequence = 0;
    const identity = element => {
      if (!element) return null;
      if (!identities.has(element)) identities.set(element, ++sequence);
      return identities.get(element);
    };
    const snapshot = () => ({ width: innerWidth, height: innerHeight, cssWidthMatches: matchMedia(`(width: ${innerWidth}px)`).matches, screenPadding: document.querySelector('.screen') ? getComputedStyle(document.querySelector('.screen')).paddingLeft : null, scrollY, clientWidth: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, graphs: [...document.querySelectorAll('.knowledge-graph-stage')].map(stage => {
      const host = stage.querySelector('.knowledge-graph-stage__webgl'), canvas = host?.querySelector('canvas');
      return { stageId: identity(stage), canvasId: identity(canvas), scope: stage.dataset.scopeKey,
        state: stage.dataset.engineState, renderState: stage.dataset.renderState, painted: host?.dataset.paintedSize,
        aspect: host?.dataset.paintedAspect, viewport: getComputedStyle(stage.querySelector('.knowledge-graph-stage__viewport')).minHeight,
        raster: canvas?.__graphRaster, buffer: canvas ? [canvas.width,canvas.height] : null, hostSize: host ? [host.clientWidth,host.clientHeight] : null,
        labels: [...stage.querySelectorAll('.knowledge-graph-stage__label:not([hidden])')].map(label => label.textContent),
        nodes: stage.querySelectorAll('.knowledge-graph-stage__nodes button').length,
      };
    }) });
    const fetchOriginal = window.fetch;
    window.fetch = async function(...args) {
      const request = args[0], url = new URL(typeof request === 'string' ? request : request.url ?? String(request), location.href);
      const tracked = /^\/api\/v1\/(?:pg\/)?(?:documents|vault)\//.test(url.pathname) && !url.pathname.endsWith('/events');
      const entry = tracked ? { id: ++sequence, path: url.pathname + url.search, method: args[1]?.method ?? request.method ?? 'GET', start: performance.now() } : null;
      if (entry) { traffic.push(entry); if (traffic.length > 100) traffic.shift(); }
      try { const response = await fetchOriginal.apply(this,args); if (entry) { entry.response = performance.now(); entry.status = response.status; } return response; }
      catch (error) { if (entry) { entry.finished = performance.now(); entry.error = error.name; } throw error; }
    };
    window.__graphCaptureAudit = {
      snapshot, traffic,
      prepare(width) {
        let positioned = false, before, started, previous, resolveReady;
        const events = [], readiness = [];
        const ready = current => current.width === width && current.cssWidthMatches && current.screenPadding === (width <= 767 ? '14px' : '20px') && current.height === 900 && current.graphs.length === 2 && current.graphs.every(graph => {
          if (graph.state === 'empty') return graph.nodes === 0;
          if (!graph.canvasId || !graph.hostSize || !graph.buffer) return false;
          const [w,h] = graph.hostSize;
          return graph.state === 'ready' && graph.renderState === 'idle' && graph.labels.length > 0
            && graph.viewport === (width <= 768 ? '280px' : '420px')
            && graph.painted === `${w}:${h}` && graph.aspect === String(w/h)
            && graph.buffer[0] === Math.round(w*devicePixelRatio) && graph.buffer[1] === Math.round(h*devicePixelRatio);
        });
        const observe = (records = []) => {
          const current = snapshot();
          if (!before) {
            if (positioned) readiness.push({ at: performance.now(), width: current.width, cssWidthMatches: current.cssWidthMatches, screenPadding: current.screenPadding, graphs: current.graphs.map(graph=>({ canvasId: graph.canvasId, state: graph.state, hostSize: graph.hostSize, painted: graph.painted })) });
            if (positioned && ready(current)) { before = current; started = performance.now(); previous = JSON.stringify(current); clearTimeout(timer); resolveReady(current); }
            return;
          }
          for (const record of records) if (record.type === 'attributes' && record.target.matches('.knowledge-graph-stage, .knowledge-graph-stage canvas') && ['data-engine-state','data-render-state','data-scope-key','width','height'].includes(record.attributeName)) {
            events.push({ at: performance.now(), attribute: record.attributeName, elementId: identity(record.target), previous: record.oldValue, current: record.target.getAttribute(record.attributeName) });
          }
          const signature = JSON.stringify(current); if (signature !== previous) { events.push({ at: performance.now(), state: current }); previous = signature; }
        };
        const observer = new MutationObserver(observe);
        let timer;
        window.__graphCaptureReady = new Promise((resolve,reject) => { resolveReady = resolve; timer = setTimeout(() => { observer.disconnect(); reject(new Error('Integrated graph capture readiness deadline')); },20000); });
        observer.observe(document.documentElement, { attributes: true, attributeOldValue: true, childList: true, subtree: true });
        window.__graphCaptureWindow = {
          get started() { return started; },
          positioned() { positioned = true; observe(observer.takeRecords()); },
          finish() { observe(observer.takeRecords()); observer.disconnect(); clearTimeout(timer); return { before, after: snapshot(), events, readiness, started, finished: performance.now(), traffic: traffic.map(entry=>({...entry})) }; },
        };
      },
    };
    for (const type of [WebGLRenderingContext, WebGL2RenderingContext]) {
      const prototype = type.prototype, location = prototype.getUniformLocation, matrix = prototype.uniformMatrix4fv, draw = prototype.drawElements;
      prototype.getUniformLocation = function(program, name) { const value = location.call(this, program, name); if (value) names.set(value, name); return value; };
      prototype.uniformMatrix4fv = function(...args) { if (names.get(args[0]) === 'projectionMatrix') projections.set(this, args[2][5] / args[2][0]); return matrix.apply(this, args); };
      prototype.drawElements = function(...args) {
        const value = draw.apply(this, args);
        if (this.getParameter(this.FRAMEBUFFER_BINDING) === null) this.canvas.__graphRaster = { projection: projections.get(this), viewport: [...this.getParameter(this.VIEWPORT)], buffer: [this.drawingBufferWidth, this.drawingBufferHeight] };
        return value;
      };
    }
  });
}

// Wait for an actual compositor frame newer than the ready snapshot, not a timer/RAF guess.
async function awaitPresentedFrame(page, expected) {
  const notBefore = await page.evaluate(() => performance.timeOrigin + window.__graphCaptureWindow.started);
  const session = await page.context().newCDPSession(page);
  let timer, onFrame;
  try {
    const presented = new Promise((resolve,reject) => {
      timer = setTimeout(() => reject(new Error('Graph compositor presentation deadline')),20000);
      onFrame = event => {
        const current = typeof event.metadata.timestamp === 'number' && event.metadata.timestamp * 1000 >= notBefore
          && event.metadata.deviceWidth === expected.width && event.metadata.deviceHeight === expected.height
          && event.metadata.scrollOffsetY === expected.scrollY;
        if (current) session.off('Page.screencastFrame',onFrame);
        session.send('Page.screencastFrameAck',{sessionId:event.sessionId}).then(() => { if (current) resolve(event.metadata); },reject);
      };
      session.on('Page.screencastFrame',onFrame);
    });
    await session.send('Page.startScreencast',{format:'png',everyNthFrame:1});
    return await presented;
  } finally {
    clearTimeout(timer);session.off('Page.screencastFrame',onFrame);
    await session.send('Page.stopScreencast');await session.detach();
  }
}

// Subscribe before resizing; the signal requires actual settled, painted WebGL and labels.
export async function captureGraphSurface(page, evidence, name) {
  const captures = [], images = [];
  for (const width of [1280, 768, 375]) {
    for (const [surface,selector] of [['original','.graph-layout'],['wiki','[data-wiki-workspace] .knowledge-graph-stage']]) {
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(width => window.__graphCaptureAudit.prepare(width), width);
    if (surface === 'original') await page.setViewportSize({ width, height: 900 });
    await page.evaluate(selector => { const target=document.querySelector(selector);window.scrollTo(0,Math.max(0,target.getBoundingClientRect().top+scrollY-96));window.__graphCaptureWindow.positioned(); },selector);
    let state;
    try { state = await page.evaluate(() => window.__graphCaptureReady); }
    catch (error) { error.audit = await page.evaluate(() => window.__graphCaptureWindow.finish()); throw error; }
    let image, audit, presentation;
    try {
    assert.ok(state.scroll <= state.width + 1, JSON.stringify(state));
    assert.equal(state.graphs.length, 2);
    assert.ok(state.graphs.every(graph => graph.state === 'empty' ? graph.nodes === 0 : graph.state === 'ready' && graph.renderState === 'idle' && graph.labels.length > 0), JSON.stringify(state));
    for (const graph of state.graphs.filter(graph => graph.state !== 'empty')) {
      assert.ok(graph.raster, JSON.stringify(graph));
      assert.deepEqual(graph.raster.viewport, [0, 0, ...graph.raster.buffer], JSON.stringify(graph));
      assert.ok(Math.abs(graph.raster.projection - Number(graph.aspect)) < 1e-5, JSON.stringify(graph));
    }
    presentation = await awaitPresentedFrame(page,state);
    assert.equal(presentation.deviceWidth,state.width);
    assert.equal(presentation.deviceHeight,state.height);
    assert.equal(presentation.scrollOffsetY,state.scrollY);
    // Avoid captureBeyondViewport and screenshot-time CSS changes in the live graph.
    image = await page.screenshot({ fullPage: false, animations: 'allow', caret: 'initial' });
    } finally { audit = await page.evaluate(() => window.__graphCaptureWindow.finish()); }
    const file = `${name}-${width}${surface==='wiki'?'-wiki':''}.png`;
    if (audit.events.length || JSON.stringify(audit.before) !== JSON.stringify(audit.after)) {
      const rejected = `${file}.rejected-${createHash('sha256').update(JSON.stringify(audit)).digest('hex').slice(0,12)}`;
      await writeFile(path.join(evidence, `${rejected}.json`), JSON.stringify(audit,null,2));
      await writeFile(path.join(evidence, `${rejected}.png`), image);
      throw Object.assign(new Error(`GRAPH_CAPTURE_CHANGED: ${file}`), { code: 'GRAPH_CAPTURE_CHANGED', audit });
    }
    images.push({ file, image });
    captures.push({ file, surface, captureMode: 'viewport', ...audit.after, sha256: createHash('sha256').update(image).digest('hex'), captureAudit: { presentation, started: audit.started, finished: audit.finished, beforeCanvasIds: audit.before.graphs.map(graph=>graph.canvasId), afterCanvasIds: audit.after.graphs.map(graph=>graph.canvasId), changes: 0, readiness: audit.readiness, traffic: audit.traffic.filter(entry=>entry.start>=audit.started || entry.response>=audit.started) } });
    }
  }
  await Promise.all(images.map(({file,image}) => writeFile(path.join(evidence,file),image)));
  return captures;
}

export async function assertConsentSummary(page, preview) {
  const panel = page.locator(`[data-consent-hash="${preview.scope_hash}"]`);
  const rows = panel.locator('[data-consent-input]');
  assert.equal(await rows.count(), preview.scope.inputs.length);
  for (const [index, input] of preview.scope.inputs.entries()) {
    const row = rows.nth(index);
    assert.equal(await row.getAttribute('data-input-kind'), input.kind ?? input.role ?? 'unknown');
    assert.equal(await row.getAttribute('data-input-classification'), input.classification ?? 'unknown');
    assert.equal(await row.getAttribute('data-input-version'), input.version === undefined ? null : String(input.version));
    assert.equal(await row.getAttribute('data-input-revision'), input.revision_id ?? null);
    if (typeof input.title === 'string') assert.ok((await row.innerText()).includes(input.title));
    if (['instruction', 'catalog', 'question'].includes(input.kind)) assert.equal(await row.getAttribute('data-input-version'), null);
  }
  const exact = panel.locator('[data-consent-exact]');
  assert.equal(await exact.getAttribute('open'), null);
  assert.deepEqual(JSON.parse(await exact.locator('pre').textContent()), preview.scope);
  assert.equal(await panel.locator('input[type="checkbox"]').isChecked(), false);
  await exact.locator('summary').click();
  assert.equal(await exact.locator('pre').isVisible(), true);
  await exact.locator('summary').click();
  assert.equal(await panel.locator('input[type="checkbox"]').isChecked(), false);
}
