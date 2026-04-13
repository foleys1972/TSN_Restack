const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('ssh2');
const { v4: uuidv4 } = require('uuid');

const runtimeRoot = process.pkg ? path.dirname(process.execPath) : __dirname;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(runtimeRoot, 'public')));

const DATA_DIR = path.join(runtimeRoot, 'data');
const SITES_PATH = path.join(DATA_DIR, 'sites.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

const SSH_USERNAME = 'root';

const DEFAULT_SETTINGS = {
  sshPassword: 'admin',
  clusterResetSafetyPassword: '969131'
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

const jobs = new Map();

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

function runInteractiveClusterReset(conn, { onData } = {}) {
  return new Promise((resolve, reject) => {
    conn.shell({ term: 'xterm-color', cols: 120, rows: 40 }, (err, stream) => {
      if (err) return reject(err);

      let combined = '';
      const write = (s) => {
        stream.write(s);
      };

      const sendKeysSequence = async () => {
        write('configure-node\n');
        await new Promise((r) => setTimeout(r, 1500));

        for (let i = 0; i < 5; i++) {
          write('\u001b[B');
          await new Promise((r) => setTimeout(r, 150));
        }
        write('\n');
        await new Promise((r) => setTimeout(r, 1200));

        write('\u001b[B');
        await new Promise((r) => setTimeout(r, 150));
        write('\n');
        await new Promise((r) => setTimeout(r, 1200));

        write('\n');
        await new Promise((r) => setTimeout(r, 9000));

        write('\u001b');
        await new Promise((r) => setTimeout(r, 500));
        write('\u001b');
        await new Promise((r) => setTimeout(r, 500));

        resolve({ ok: true, output: combined });
        stream.end();
      };

      stream.on('data', (d) => {
        const s = d.toString('utf8');
        combined += s;
        onData?.(s);
      });

      stream.on('close', () => {
        resolve({ ok: true, output: combined });
      });

      stream.on('error', (e) => {
        reject(e);
      });

      sendKeysSequence().catch(reject);
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

app.post('/api/sites/:id/restack', async (req, res) => {
  const data = await loadSites();
  const site = data.sites.find((s) => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'site not found' });

  const job = createJob('restack', site);
  setJobStatus(job, 'running');
  appendJobLog(job, `Connecting to ${site.host}:${site.port} as ${SSH_USERNAME}...\n`);

  (async () => {
    let conn;
    try {
      const settings = await loadSettings();
      conn = await connectSsh({ ...site, password: settings.sshPassword });
      appendJobLog(job, 'Connected. Running: stack assure restart\n\n');
      const result = await execCommand(conn, 'stack assure restart', {
        onData: (s) => appendJobLog(job, s)
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
      try {
        conn?.end();
      } catch {
      }
    }
  })();

  res.status(202).json({ jobId: job.id });
});

app.post('/api/sites/:id/cluster-reset', async (req, res) => {
  const { confirmPassword } = req.body || {};
  const settings = await loadSettings();
  if (String(confirmPassword || '') !== String(settings.clusterResetSafetyPassword || '')) {
    return res.status(403).json({ error: 'Invalid confirmation password' });
  }

  const data = await loadSites();
  const site = data.sites.find((s) => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'site not found' });

  const job = createJob('cluster-reset', site);
  setJobStatus(job, 'running');
  appendJobLog(job, `Connecting to ${site.host}:${site.port} as ${SSH_USERNAME}...\n`);

  (async () => {
    let conn;
    try {
      conn = await connectSsh({ ...site, password: settings.sshPassword });
      appendJobLog(job, 'Connected. Launching configure-node and attempting automated reset...\n\n');
      await runInteractiveClusterReset(conn, {
        onData: (s) => appendJobLog(job, s)
      });
      job.exitCode = 0;
      setJobStatus(job, 'success');
    } catch (e) {
      job.error = String(e?.message || e);
      setJobStatus(job, 'failed');
    } finally {
      try {
        conn?.end();
      } catch {
      }
    }
  })();

  res.status(202).json({ jobId: job.id });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 5177;

(async () => {
  await ensureDataFiles();
  app.listen(PORT, () => {
    console.log(`TSN SSH Automation running on http://localhost:${PORT}`);
  });
})().catch((err) => {
  console.error('Failed to start server:', err);
  process.exitCode = 1;
});
