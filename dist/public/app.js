let sites = [];
let currentJobId = null;
let currentStream = null;
let isJobRunning = false;

const el = (id) => document.getElementById(id);

function setDisabled(id, disabled) {
  const node = el(id);
  if (!node) return;
  node.disabled = Boolean(disabled);
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
}

function renderSites() {
  const wrap = el('sites');
  const empty = el('sitesEmpty');
  const meta = el('sitesMeta');
  if (!wrap || !empty) return;

  wrap.innerHTML = '';
  if (!sites.length) {
    empty.textContent = 'No sites yet. Add one above.';
    if (meta) meta.textContent = '';
    return;
  }
  empty.textContent = '';
  if (meta) meta.textContent = `${sites.length} site${sites.length === 1 ? '' : 's'}`;

  for (const s of sites) {
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
        <button class="btn" data-action="stackStatus" data-id="${escapeHtml(s.id)}">Stack status</button>
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
}

function startJobStream(jobId) {
  resetJobView();
  currentJobId = jobId;
  setBadge('jobMeta', `Job ${jobId.slice(0, 8)}`, 'badge-muted');
  setBadge('jobStatus', 'Running', 'badge-running');
  el('jobSpinner')?.classList.remove('hidden');
  isJobRunning = true;
  setActionButtonsDisabled(true);

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
    try { es.close(); } catch {
    }
  });

  es.onerror = () => {
    setBadge('jobStatus', 'Disconnected', 'badge-danger');
    el('jobSpinner')?.classList.add('hidden');
    isJobRunning = false;
    setActionButtonsDisabled(false);
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
    showError('addSiteError', '');
    const data = await api(`/api/sites/${id}/restack`, { method: 'POST', body: JSON.stringify({}) });
    startJobStream(data.jobId);
    return;
  }

  if (action === 'stackStatus') {
    showError('addSiteError', '');
    const data = await api(`/api/sites/${id}/stack-status`, { method: 'POST', body: JSON.stringify({}) });
    startJobStream(data.jobId);
    return;
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

  loadSites().catch((err) => {
    showError('addSiteError', err.message);
  });

  resetJobView();
}

setup();
