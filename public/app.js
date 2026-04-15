let sites = [];
let currentJobId = null;
let currentStream = null;
let isJobRunning = false;
let pendingRestackSiteId = null;
let pendingClusterMenuSiteId = null;
let terminalWs = null;
let term = null;
let termDecoder = new TextDecoder();
let termFit = null;
let pendingStackStatusRefresh = false;
let sitesFilterValue = '';

const el = (id) => document.getElementById(id);

function setDisabled(id, disabled) {
  const node = el(id);
  if (!node) return;
  node.disabled = Boolean(disabled);
}

function openRestackModal() {
  const modal = el('restackModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  el('restackRun')?.focus();
}

function closeRestackModal() {
  const modal = el('restackModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  pendingRestackSiteId = null;
}

async function runConfirmedRestack() {
  if (!pendingRestackSiteId) return;
  try {
    showError('addSiteError', '');
    const data = await api(`/api/sites/${pendingRestackSiteId}/restack`, { method: 'POST', body: JSON.stringify({}) });
    closeRestackModal();
    startJobStream(data.jobId);
  } catch (err) {
    showError('addSiteError', err.message);
  }
}

function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}

function setBadge(id, text, variant) {
  const node = el(id);
  if (!node) return;
  node.textContent = text || '';
  node.classList.remove('badge-muted', 'badge-running', 'badge-success', 'badge-danger');
  node.classList.add(variant || 'badge-muted');
}

function showError(id, msg) {
  const node = el(id);
  if (node) node.textContent = msg || '';
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function stackHealthDotClass(site) {
  const state = site?.stackHealth?.state;
  if (state === 'green') return 'status-dot status-green';
  if (state === 'amber') return 'status-dot status-amber';
  if (state === 'red') return 'status-dot status-red';
  return 'status-dot status-unknown';
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = typeof body === 'object' && body && body.error ? body.error : `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

function setActionButtonsDisabled(disabled) {
  document.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.disabled = Boolean(disabled);
  });

  setDisabled('restackRun', disabled);
  setDisabled('restackCancel', disabled);
  setDisabled('clusterMenuRun', disabled);
  setDisabled('clusterMenuCancel', disabled);
}

function renderSites() {
  const wrap = el('sites');
  const empty = el('sitesEmpty');
  const meta = el('sitesMeta');
  if (!wrap || !empty) return;

  const q = String(sitesFilterValue || '').trim().toLowerCase();
  const filtered = q
    ? (sites || []).filter((s) => {
      const hay = `${s?.name || ''} ${s?.host || ''} ${s?.port || ''} ${s?.id || ''}`.toLowerCase();
      return hay.includes(q);
    })
    : (sites || []);

  wrap.innerHTML = '';
  if (!sites.length) {
    empty.textContent = 'No sites yet. Add one above.';
    if (meta) meta.textContent = '';
    return;
  }

  if (!filtered.length) {
    empty.textContent = 'No matching sites.';
  } else {
    empty.textContent = '';
  }
  if (meta) meta.textContent = `${filtered.length} / ${sites.length} site${sites.length === 1 ? '' : 's'}`;

  for (const s of filtered) {
    const card = document.createElement('div');
    card.className = 'site';
    card.innerHTML = `
      <div class="siteHeader">
        <div>
          <div class="siteTitle">${escapeHtml(s.name)}</div>
          <div class="siteMeta"><span class="mono">${escapeHtml(s.host)}:${escapeHtml(s.port)}</span></div>
        </div>
      </div>
      <div class="siteActions">
        <button class="btn btn-primary" data-action="restack" data-id="${escapeHtml(s.id)}">Run restack</button>
        <button class="btn btn-stack" data-action="stackStatus" data-id="${escapeHtml(s.id)}">
          <span class="${stackHealthDotClass(s)}" aria-hidden="true"></span>
          <span>Stack status</span>
        </button>
        <button class="btn" data-action="clusterMenu" data-id="${escapeHtml(s.id)}">TSN Cluster Menu</button>
        <button class="btn btn-ghost" data-action="delete" data-id="${escapeHtml(s.id)}">Delete</button>
      </div>
    `;
    wrap.appendChild(card);
  }

  wrap.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', onSiteAction);
  });

  setActionButtonsDisabled(isJobRunning);
}

async function loadSites() {
  setDisabled('refreshBtn', true);
  const data = await api('/api/sites');
  sites = data.sites || [];
  renderSites();
  setDisabled('refreshBtn', false);
}

function resetJobView() {
  currentJobId = null;
  if (currentStream) {
    try { currentStream.close(); } catch {
    }
    currentStream = null;
  }
  setBadge('jobMeta', '', 'badge-muted');
  setBadge('jobStatus', '', 'badge-muted');
  setText('jobLog', '');
  el('jobSpinner')?.classList.add('hidden');
  isJobRunning = false;
  setActionButtonsDisabled(false);
  setDisabled('stopJobBtn', true);
}

function startJobStream(jobId) {
  resetJobView();
  currentJobId = jobId;
  setBadge('jobMeta', `Job ${jobId.slice(0, 8)}`, 'badge-muted');
  setBadge('jobStatus', 'Running', 'badge-running');
  el('jobSpinner')?.classList.remove('hidden');
  isJobRunning = true;
  setActionButtonsDisabled(true);
  setDisabled('stopJobBtn', false);

  const logEl = el('jobLog');
  if (!logEl) return;

  const es = new EventSource(`/api/jobs/${jobId}/stream`);
  currentStream = es;

  es.addEventListener('log', (evt) => {
    try {
      const chunk = JSON.parse(evt.data);
      logEl.textContent += chunk;
      logEl.scrollTop = logEl.scrollHeight;
    } catch {
    }
  });

  es.addEventListener('done', (evt) => {
    try {
      const info = JSON.parse(evt.data);
      if (info.status === 'success') {
        setBadge('jobStatus', 'Success', 'badge-success');
      } else {
        setBadge('jobStatus', 'Failed', 'badge-danger');
      }
      if (info.error) {
        logEl.textContent += `\n\n[error] ${info.error}\n`;
      }
    } catch {
    }
    el('jobSpinner')?.classList.add('hidden');
    isJobRunning = false;
    setActionButtonsDisabled(false);
    setDisabled('stopJobBtn', true);
    if (pendingStackStatusRefresh) {
      pendingStackStatusRefresh = false;
      loadSites().catch(() => {});
    }
    try { es.close(); } catch {
    }
  });

  es.onerror = () => {
    setBadge('jobStatus', 'Disconnected', 'badge-danger');
    el('jobSpinner')?.classList.add('hidden');
    isJobRunning = false;
    setActionButtonsDisabled(false);
    setDisabled('stopJobBtn', true);
    pendingStackStatusRefresh = false;
    try { es.close(); } catch {
    }
  };
}

async function onSiteAction(e) {
  const btn = e.currentTarget;
  const action = btn.getAttribute('data-action');
  const id = btn.getAttribute('data-id');
  if (!action || !id) return;

  if (action === 'delete') {
    if (!confirm('Delete this site?')) return;
    await api(`/api/sites/${id}`, { method: 'DELETE' });
    await loadSites();
    return;
  }

  if (action === 'restack') {
    pendingRestackSiteId = id;
    openRestackModal();
    return;
  }

  if (action === 'stackStatus') {
    showError('addSiteError', '');
    const data = await api(`/api/sites/${id}/stack-status`, { method: 'POST', body: JSON.stringify({}) });
    pendingStackStatusRefresh = true;
    startJobStream(data.jobId);

    try {
      await loadSites();
    } catch {
    }
    return;
  }

  if (action === 'clusterMenu') {
    pendingClusterMenuSiteId = id;
    openClusterMenuConfirm();
  }
}

function openClusterMenuConfirm() {
  const modal = el('clusterMenuConfirmModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  el('clusterMenuRun')?.focus();
}

function closeClusterMenuConfirm() {
  const modal = el('clusterMenuConfirmModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  pendingClusterMenuSiteId = null;
}

function openTerminalModal() {
  const modal = el('terminalModal');
  if (!modal) return;
  showError('terminalError', '');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeTerminalModal() {
  const modal = el('terminalModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function terminalCleanup() {
  try {
    terminalWs?.close();
  } catch {
  }
  terminalWs = null;
  try {
    term?.dispose();
  } catch {
  }
  term = null;
  termFit = null;
}

function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

function startTerminalSession(siteId) {
  terminalCleanup();

  const hostEl = el('xterm');
  if (!hostEl) return;
  hostEl.innerHTML = '';

  openTerminalModal();

  term = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    theme: {
      background: '#040810',
      foreground: '#EAF1FF'
    }
  });
  try {
    if (window.FitAddon?.FitAddon) {
      termFit = new window.FitAddon.FitAddon();
      term.loadAddon(termFit);
    }
  } catch {
  }
  term.open(hostEl);
  try {
    termFit?.fit?.();
  } catch {
  }
  term.focus();
  term.writeln('Connecting...');

  const ws = new WebSocket(wsUrl('/ws/terminal'));
  terminalWs = ws;
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ type: 'start', siteId }));
    } catch {
    }

    try {
      termFit?.fit?.();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    } catch {
    }
  };

  ws.onmessage = (evt) => {
    if (typeof evt.data === 'string') {
      try {
        const msg = JSON.parse(evt.data);
        if (msg?.type === 'error') {
          showError('terminalError', msg.error || 'Terminal error');
          term?.writeln(`\r\n[error] ${msg.error || 'Terminal error'}\r\n`);
        }
      } catch {
        term?.write(evt.data);
      }
      return;
    }

    try {
      const text = termDecoder.decode(evt.data);
      term?.write(text);
    } catch {
    }
  };

  ws.onclose = () => {
    try {
      term?.writeln('\r\n[disconnected]');
    } catch {
    }
  };

  ws.onerror = () => {
    showError('terminalError', 'WebSocket error');
  };

  term.onData((data) => {
    try {
      ws.send(JSON.stringify({ type: 'input', data }));
    } catch {
    }
  });

  const onResize = () => {
    try {
      termFit?.fit?.();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    } catch {
    }
  };
  window.addEventListener('resize', onResize);
  ws.addEventListener('close', () => window.removeEventListener('resize', onResize));
}

async function runConfirmedClusterMenu() {
  if (!pendingClusterMenuSiteId) return;
  const siteId = pendingClusterMenuSiteId;
  closeClusterMenuConfirm();
  startTerminalSession(siteId);
}

async function stopCurrentJob() {
  if (!currentJobId) return;
  try {
    await api(`/api/jobs/${currentJobId}/stop`, { method: 'POST', body: JSON.stringify({}) });
  } catch (err) {
    showError('addSiteError', err.message);
  }
}

function setup() {
  el('addSiteForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      showError('addSiteError', '');
      setDisabled('addSiteBtn', true);
      const name = el('siteName')?.value || '';
      const host = el('siteHost')?.value || '';
      const portRaw = el('sitePort')?.value || '';
      const port = portRaw ? Number(portRaw) : undefined;

      await api('/api/sites', {
        method: 'POST',
        body: JSON.stringify({ name, host, port })
      });

      if (el('siteName')) el('siteName').value = '';
      if (el('siteHost')) el('siteHost').value = '';
      if (el('sitePort')) el('sitePort').value = '';
      await loadSites();
    } catch (err) {
      showError('addSiteError', err.message);
    } finally {
      setDisabled('addSiteBtn', false);
    }
  });

  el('refreshBtn')?.addEventListener('click', async () => {
    await loadSites();
  });

  el('sitesFilter')?.addEventListener('input', (e) => {
    sitesFilterValue = e?.target?.value || '';
    renderSites();
  });

  el('restackCancel')?.addEventListener('click', closeRestackModal);
  el('restackRun')?.addEventListener('click', runConfirmedRestack);

  el('restackModal')?.addEventListener('click', (e) => {
    if (e.target === el('restackModal')) closeRestackModal();
  });

  el('clusterMenuCancel')?.addEventListener('click', closeClusterMenuConfirm);
  el('clusterMenuRun')?.addEventListener('click', runConfirmedClusterMenu);

  el('clusterMenuConfirmModal')?.addEventListener('click', (e) => {
    if (e.target === el('clusterMenuConfirmModal')) closeClusterMenuConfirm();
  });

  el('terminalClose')?.addEventListener('click', () => {
    try {
      terminalWs?.send(JSON.stringify({ type: 'close' }));
    } catch {
    }
    terminalCleanup();
    closeTerminalModal();
  });

  el('terminalModal')?.addEventListener('click', (e) => {
    if (e.target === el('terminalModal')) {
      try {
        terminalWs?.send(JSON.stringify({ type: 'close' }));
      } catch {
      }
      terminalCleanup();
      closeTerminalModal();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = el('restackModal');
      if (modal && !modal.classList.contains('hidden')) closeRestackModal();

      const clusterModal = el('clusterMenuConfirmModal');
      if (clusterModal && !clusterModal.classList.contains('hidden')) closeClusterMenuConfirm();

      const termModal = el('terminalModal');
      if (termModal && !termModal.classList.contains('hidden')) {
        try {
          terminalWs?.send(JSON.stringify({ type: 'close' }));
        } catch {
        }
        terminalCleanup();
        closeTerminalModal();
      }
    }
  });

  el('stopJobBtn')?.addEventListener('click', stopCurrentJob);

  loadSites().catch((err) => {
    showError('addSiteError', err.message);
  });

  resetJobView();
  setDisabled('stopJobBtn', true);
}

setup();
setup();
