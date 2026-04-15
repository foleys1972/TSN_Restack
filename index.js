const express = require('express');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { Client } = require('ssh2');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');

const runtimeRoot = process.pkg ? path.dirname(process.execPath) : __dirname;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(runtimeRoot, 'public')));

const DATA_DIR = path.join(runtimeRoot, 'data');
const SITES_PATH = path.join(DATA_DIR, 'sites.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

const SSH_USERNAME = 'root';

const DEFAULT_SETTINGS = {
  sshPassword: 'admin'
};

async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS };
    return {
      ...DEFAULT_SETTINGS,
      ...parsed
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function ensureSettingsFile() {
  try {
    await fs.access(SETTINGS_PATH);
  } catch {
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
  }
}

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(SITES_PATH);
  } catch {
    await fs.writeFile(SITES_PATH, JSON.stringify({ sites: [] }, null, 2), 'utf8');
  }

  await ensureSettingsFile();
}

async function loadSites() {
  const raw = await fs.readFile(SITES_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sites)) return { sites: [] };
  return parsed;
}

async function saveSites(data) {
  await fs.writeFile(SITES_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function deriveStackHealthFromOutput(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((l) => l.trim());

  let inStack = false;
  let total = 0;
  let running = 0;

  for (const line of lines) {
    if (!line) continue;

    if (/^Stack:\s*/i.test(line)) {
      inStack = true;
      continue;
    }

    if (!inStack) continue;

    if (/^[-_]{3,}$/.test(line)) continue;

    const looksLikeServiceLine = /:\s*/.test(line);
    if (!looksLikeServiceLine) continue;

    total += 1;

    if (/\bRunning\b/i.test(line) || /\bUp\b/i.test(line)) {
      running += 1;
      continue;
    }
  }

  if (total === 0) return { state: 'red', running: 0, total: 0 };
  if (running === 0) return { state: 'red', running, total };
  if (running === total) return { state: 'green', running, total };
  return { state: 'amber', running, total };
}

async function updateSiteStackHealth(siteId, stackHealth) {
  const data = await loadSites();
  const idx = data.sites.findIndex((s) => s.id === siteId);
  if (idx === -1) return;
  data.sites[idx] = {
    ...data.sites[idx],
    stackHealth: {
      ...stackHealth,
      updatedAt: new Date().toISOString()
    }
  };
  await saveSites(data);
}

const jobs = new Map();
const runningJobs = new Map();

function createJob(type, site) {
  const id = uuidv4();
  const job = {
    id,
    type,
    site,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    log: ''
  };
  jobs.set(id, job);
  return job;
}

function appendJobLog(job, chunk) {
  job.log += chunk;
}

function setJobStatus(job, status) {
  job.status = status;
  if (status === 'running') job.startedAt = new Date().toISOString();
  if (status === 'success' || status === 'failed') job.finishedAt = new Date().toISOString();
}

function connectSsh({ host, port = 22, password }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', (err) => reject(err))
      .connect({
        host,
        port,
        username: SSH_USERNAME,
        password,
        readyTimeout: 20000,
        keepaliveInterval: 10000
      });
  });
}

function trackRunningJob(jobId, { conn, stream }) {
  runningJobs.set(jobId, { conn, stream });
}

function untrackRunningJob(jobId) {
  runningJobs.delete(jobId);
}

function stopRunningJob(jobId) {
  const handles = runningJobs.get(jobId);
  if (!handles) return false;
  try {
    handles.stream?.close?.();
  } catch {
  }
  try {
    handles.stream?.end?.();
  } catch {
  }
  try {
    handles.conn?.end?.();
  } catch {
  }
  try {
    handles.conn?.destroy?.();
  } catch {
  }
  untrackRunningJob(jobId);
  return true;
}

function execCommand(conn, command, { onData } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: true }, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';

      stream.on('data', (d) => {
        const s = d.toString('utf8');
        stdout += s;
        onData?.(s);
      });

      stream.stderr.on('data', (d) => {
        const s = d.toString('utf8');
        stderr += s;
        onData?.(s);
      });

      stream.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  });
}

app.get('/api/sites', async (req, res) => {
  const data = await loadSites();
  res.json({ sites: data.sites });
});

app.post('/api/sites', async (req, res) => {
  const { name, host, port } = req.body || {};
  if (!name || !host) return res.status(400).json({ error: 'name and host are required' });

  const data = await loadSites();
  const site = {
    id: uuidv4(),
    name: String(name),
    host: String(host),
    port: port ? Number(port) : 22,
    createdAt: new Date().toISOString()
  };
  data.sites.push(site);
  await saveSites(data);
  res.status(201).json({ site });
});

app.delete('/api/sites/:id', async (req, res) => {
  const data = await loadSites();
  const idx = data.sites.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'site not found' });
  const [removed] = data.sites.splice(idx, 1);
  await saveSites(data);
  res.json({ removed });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({ job });
});

app.post('/api/jobs/:id/stop', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.status !== 'running') return res.status(409).json({ error: 'job is not running' });

  const stopped = stopRunningJob(job.id);
  if (!stopped) return res.status(409).json({ error: 'job cannot be stopped' });

  job.exitCode = null;
  job.error = 'Stopped by user';
  setJobStatus(job, 'failed');
  appendJobLog(job, '\n\n[stopped] Job stopped by user\n');
  return res.json({ ok: true });
});

app.get('/api/jobs/:id/stream', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  let lastLen = 0;
  const interval = setInterval(() => {
    const current = job.log;
    if (current.length > lastLen) {
      const diff = current.slice(lastLen);
      lastLen = current.length;
      res.write(`event: log\n`);
      res.write(`data: ${JSON.stringify(diff)}\n\n`);
    }

    if (job.status === 'success' || job.status === 'failed') {
      res.write(`event: done\n`);
      res.write(`data: ${JSON.stringify({ status: job.status, exitCode: job.exitCode, error: job.error })}\n\n`);
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on('close', () => {
    clearInterval(interval);
  });
});

app.post('/api/sites/:id/stack-status', async (req, res) => {
  const data = await loadSites();
  const site = data.sites.find((s) => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'site not found' });

  const job = createJob('stack-status', site);
  setJobStatus(job, 'running');
  appendJobLog(job, `Connecting to ${site.host}:${site.port} as ${SSH_USERNAME}...\n`);

  (async () => {
    let conn;
    let stream;
    try {
      const settings = await loadSettings();
      conn = await connectSsh({ ...site, password: settings.sshPassword });
      appendJobLog(job, 'Connected. Running: stack status\n\n');
      const result = await new Promise((resolve, reject) => {
        conn.exec('stack status', { pty: true }, (err, s) => {
          if (err) return reject(err);
          stream = s;
          trackRunningJob(job.id, { conn, stream });
          let stdout = '';
          let stderr = '';

          stream.on('data', (d) => {
            const out = d.toString('utf8');
            stdout += out;
            appendJobLog(job, out);
          });

          stream.stderr.on('data', (d) => {
            const out = d.toString('utf8');
            stderr += out;
            appendJobLog(job, out);
          });

          stream.on('close', (code) => resolve({ code, stdout, stderr }));
        });
      });

      try {
        const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
        const health = deriveStackHealthFromOutput(combined);
        await updateSiteStackHealth(site.id, health);
      } catch {
      }

      job.exitCode = result.code;
      if (result.code === 0) {
        setJobStatus(job, 'success');
      } else {
        job.error = `Command exited with code ${result.code}`;
        setJobStatus(job, 'failed');
      }
    } catch (e) {
      job.error = String(e?.message || e);
      setJobStatus(job, 'failed');
    } finally {
      untrackRunningJob(job.id);
      try {
        conn?.end();
      } catch {
      }
    }
  })();

  res.status(202).json({ jobId: job.id });
});

app.post('/api/sites/:id/restack', async (req, res) => {
  const data = await loadSites();
  const site = data.sites.find((s) => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'site not found' });

  const job = createJob('restack', site);
  setJobStatus(job, 'running');
  appendJobLog(job, `Connecting to ${site.host}:${site.port} as ${SSH_USERNAME}...\n`);

  (async () => {
    let conn;
    let stream;
    try {
      const settings = await loadSettings();
      conn = await connectSsh({ ...site, password: settings.sshPassword });
      appendJobLog(job, 'Connected. Running: stack -L restart\n\n');
      const result = await new Promise((resolve, reject) => {
        conn.exec('stack -L restart', { pty: true }, (err, s) => {
          if (err) return reject(err);
          stream = s;
          trackRunningJob(job.id, { conn, stream });
          let stdout = '';
          let stderr = '';

          stream.on('data', (d) => {
            const out = d.toString('utf8');
            stdout += out;
            appendJobLog(job, out);
          });

          stream.stderr.on('data', (d) => {
            const out = d.toString('utf8');
            stderr += out;
            appendJobLog(job, out);
          });

          stream.on('close', (code) => resolve({ code, stdout, stderr }));
        });
      });
      job.exitCode = result.code;
      if (result.code === 0) {
        setJobStatus(job, 'success');
      } else {
        job.error = `Command exited with code ${result.code}`;
        setJobStatus(job, 'failed');
      }
    } catch (e) {
      job.error = String(e?.message || e);
      setJobStatus(job, 'failed');
    } finally {
      untrackRunningJob(job.id);
      try {
        conn?.end();
      } catch {
      }
    }
  })();

  res.status(202).json({ jobId: job.id });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 5177;

const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: '/ws/terminal' });
const terminalSessions = new Map();

wss.on('connection', (ws) => {
  const sessionId = uuidv4();
  terminalSessions.set(sessionId, { ws, conn: null, stream: null, closed: false });

  ws.on('message', async (msg) => {
    const session = terminalSessions.get(sessionId);
    if (!session || session.closed) return;

    const text = Buffer.isBuffer(msg) ? msg.toString('utf8') : String(msg);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (session.stream) {
        try {
          session.stream.write(msg);
        } catch {
        }
      }
      return;
    }

    if (parsed?.type === 'start') {
      const siteId = String(parsed.siteId || '');
      const data = await loadSites();
      const site = data.sites.find((s) => s.id === siteId);
      if (!site) {
        try { ws.send(JSON.stringify({ type: 'error', error: 'site not found' })); } catch {
        }
        return;
      }

      const settings = await loadSettings();
      let conn;
      try {
        conn = await connectSsh({ ...site, password: settings.sshPassword });
      } catch (e) {
        try { ws.send(JSON.stringify({ type: 'error', error: String(e?.message || e) })); } catch {
        }
        return;
      }

      session.conn = conn;

      conn.shell({ term: 'xterm-256color', cols: 120, rows: 40 }, (err, stream) => {
        if (err) {
          try { ws.send(JSON.stringify({ type: 'error', error: String(err?.message || err) })); } catch {
          }
          try { conn.end(); } catch {
          }
          return;
        }

        session.stream = stream;

        stream.on('data', (d) => {
          try { ws.send(d); } catch {
          }
        });
        stream.stderr.on('data', (d) => {
          try { ws.send(d); } catch {
          }
        });
        stream.on('close', () => {
          try { ws.close(); } catch {
          }
        });

        try {
          stream.write('configure-node\n');
        } catch {
        }
      });

      return;
    }

    if (parsed?.type === 'input') {
      if (!session.stream) return;
      const data = typeof parsed.data === 'string' ? parsed.data : '';
      try {
        session.stream.write(data);
      } catch {
      }
      return;
    }

    if (parsed?.type === 'resize') {
      if (!session.stream) return;
      const cols = Number(parsed.cols || 120);
      const rows = Number(parsed.rows || 40);
      try {
        session.stream.setWindow(rows, cols, rows, cols);
      } catch {
      }
      return;
    }

    if (parsed?.type === 'close') {
      try {
        session.stream?.end?.();
      } catch {
      }
      try {
        session.conn?.end?.();
      } catch {
      }
      try { ws.close(); } catch {
      }
    }
  });

  ws.on('close', () => {
    const session = terminalSessions.get(sessionId);
    if (!session) return;
    session.closed = true;
    try {
      session.stream?.end?.();
    } catch {
    }
    try {
      session.conn?.end?.();
    } catch {
    }
    terminalSessions.delete(sessionId);
  });
});

(async () => {
  await ensureDataFiles();
  server.listen(PORT, () => {
    console.log(`TSN SSH Automation running on http://localhost:${PORT}`);
  });
})().catch((err) => {
  console.error('Failed to start server:', err);
  process.exitCode = 1;
});
