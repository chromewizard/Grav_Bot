const { app, BrowserWindow, ipcMain, shell, nativeImage, Menu, systemPreferences, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');

// Prevent CLI probes (like --help / --version) or duplicate launches from spawning a second Dock icon
if (process.argv.includes('--help') || process.argv.includes('--version') || process.argv.includes('-v')) {
  process.exit(0);
}

app.setName('Grav Bot Public Preview');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

const HOME = os.homedir();
const USER_DATA_DIR = process.env.GRAV_BOT_DATA_DIR || path.join(app.getPath('appData'), 'Grav Bot Public Preview');
const PERSISTENCE_DIR = path.join(USER_DATA_DIR, 'persistence');
const DROPPED_DIR = path.join(USER_DATA_DIR, 'dropped');
const DROPPED_MANIFEST_FILE = path.join(PERSISTENCE_DIR, 'dropped_items_v1.json');
const APP_WORKSPACE_DIR = path.join(USER_DATA_DIR, 'workspace');
const WORKSPACE_DIR = process.env.GRAV_BOT_WORKSPACE ? path.resolve(process.env.GRAV_BOT_WORKSPACE) : APP_WORKSPACE_DIR;
const STATE_FILE = path.join(PERSISTENCE_DIR, 'grav_bot_state_v2.json');
const SETTINGS_FILE = path.join(USER_DATA_DIR, 'settings_v2.json');
const DAEMON_PORT = 61558;
const CURRENT_SCHEMA_VERSION = 2;

let mainWindow = null;
let appState = null;
let droppedItems = [];
let appSettings = {
  agyPath: process.env.GRAV_BOT_AGY_PATH || path.join(HOME, '.local', 'bin', 'agy'),
  effort: 'low',
  skipPermissions: false,
  autoRoute: false,
  autoResume: false,
  soundEffects: true,
  uiState: {}
};

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function copyDirRecursiveSync(src, dest, overwrite = false) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sPath = path.join(src, entry.name);
    const dPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveSync(sPath, dPath, overwrite);
    } else if (overwrite || !fs.existsSync(dPath)) {
      fs.writeFileSync(dPath, fs.readFileSync(sPath));
    }
  }
}

function getFreshDefaultState() {
  const mainId = '61d41ebd-32f8-4633-83bd-37363a241570';
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    primaryBotId: mainId,
    roster: [
      {
        id: mainId,
        name: 'Grav Bot',
        title: 'Primary Bot',
        description: 'Your main point of contact. Coordinates work with your other Bots on Antigravity.',
        systemPrompt: 'You are Grav Bot, the user\'s primary assistant and point of contact running inside Grav Bot on Antigravity.',
        avatarShape: 'blob',
        avatarColor: 'black',
        isPrimary: true,
        isPinned: true,
        isGroup: false,
        memberIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastActivityAt: Date.now(),
        lastEntry: {
          kind: 'text',
          text: 'Ready on Antigravity.'
        }
      }
    ],
    transcripts: {
      [mainId]: []
    }
  };
}

function loadBundledCharactersSeed(preferPublic = false) {
  const privateSeedPath = path.join(PERSISTENCE_DIR, 'private_characters_seed.json');
  const bundledSeedPath = path.join(__dirname, 'seed', 'grav_bot_characters.json');
  const seedPath = (!preferPublic && fs.existsSync(privateSeedPath)) ? privateSeedPath : bundledSeedPath;
  if (fs.existsSync(seedPath)) {
    const data = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const seeded = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      primaryBotId: data.primaryBotId,
      roster: data.roster,
      transcripts: data.transcripts
    };
    sanitizeLoadedState(seeded);
    return seeded;
  }
  return getFreshDefaultState();
}

function saveDroppedManifest() {
  try {
    fs.writeFileSync(DROPPED_MANIFEST_FILE, JSON.stringify(droppedItems, null, 2), 'utf8');
  } catch (e) {}
}

function ensureDirectoriesAndState() {
  fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(DROPPED_DIR, { recursive: true });

  if (fs.existsSync(DROPPED_MANIFEST_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DROPPED_MANIFEST_FILE, 'utf8'));
      if (Array.isArray(parsed)) {
        droppedItems = parsed;
      }
    } catch (e) {}
  }

  // Load settings
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      appSettings = { ...appSettings, ...saved };
    } catch (e) {}
  } else {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2), 'utf8');
  }

  const forceBuildReset = process.argv.includes('--reset') || process.env.GRAV_BOT_RESET === '1';

  // Load v2 state or seed with clean 21 characters
  if (!forceBuildReset && fs.existsSync(STATE_FILE)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (loaded && loaded.schemaVersion === CURRENT_SCHEMA_VERSION && Array.isArray(loaded.roster)) {
        sanitizeLoadedState(loaded);
        appState = loaded;
        saveAppState();
        return;
      }
    } catch (e) {}
  }

  appState = loadBundledCharactersSeed(process.argv.includes('--reset-public'));
  saveAppState();
}

const CLEAN_BOT_PROFILES = {};

const BOT_PRACTICAL_MODEL_SPLIT = {
  'Grav Bot': { model: 'gemini-4-argon-low', effort: 'low', fallbackModel: 'gemini-3.8-flash-low' },
  'Architect': { model: 'gemini-4-argon-low', effort: 'low', fallbackModel: 'gemini-3.8-flash-low' },
  'Antigravity Code Crusher Relay': { model: 'gemini-4-argon-medium', effort: 'medium', fallbackModel: 'gemini-4-argon-low' },
  'Cursor Code Crusher Relay': { model: 'gemini-4-argon-medium', effort: 'medium', fallbackModel: 'gemini-4-argon-low' },
  'Divine Beauty': { model: 'gemini-4-argon-medium', effort: 'medium', fallbackModel: 'gemini-4-argon-low' },
  'QA Lightning Mode': { model: 'gemini-4-argon-low', effort: 'low', fallbackModel: 'gemini-3.8-flash-low' },
  'QA Design Elegance': { model: 'gemini-4-argon-low', effort: 'low', fallbackModel: 'gemini-3.8-flash-low' },
  'Engineering & Design QA Room': { model: 'gemini-4-argon-low', effort: 'low', fallbackModel: 'gemini-3.8-flash-low' },
  'Design Studio Room': { model: 'gemini-4-argon-medium', effort: 'medium', fallbackModel: 'gemini-4-argon-low' }
};

const ASSET_PREFIX_TO_REL = {};

function resolveAssetRelPath(urlOrPath) {
  if (!urlOrPath) return null;
  const base = path.basename(String(urlOrPath));
  const prefix = base.split('.')[0].slice(0, 20).toLowerCase();
  const rel = ASSET_PREFIX_TO_REL[prefix];
  if (rel && (fs.existsSync(path.join(WORKSPACE_DIR, rel)) || fs.existsSync(path.join(APP_WORKSPACE_DIR, rel)))) {
    return rel;
  }
  return null;
}

function sanitizeLoadedState(state) {
  if (!state || !state.transcripts) return;
  for (const r of state.roster || []) {
    if (r.name === 'Cursor Code Crusher Relay') {
      r.name = 'Antigravity Code Crusher Relay';
    }
    const cleanProfile = CLEAN_BOT_PROFILES[r.name];
    if (cleanProfile) {
      if (!r.title || r.title === 'Bot' || r.title === 'Group' || r.title === 'Timestamp Geolocation' || r.title === 'Designer' || r.title === 'Architect' || r.title === 'Negotiation' || r.title === 'Compliance') {
        r.title = cleanProfile.title;
      }
      if (!r.description || r.description.length < 30 || r.description.includes('SetPrimaryBot')) {
        r.description = cleanProfile.description;
      }
      if (
        !r.systemPrompt ||
        r.systemPrompt.includes('=== GRAV BOT & GEMINI ANTIGRAVITY ENVIRONMENT IDENTITY ===') ||
        r.systemPrompt.includes('LEGACY_PRIVATE_PROFILE') ||
        r.systemPrompt.includes('GRAVBOT_HANDOFF_')
      ) {
        r.systemPrompt = cleanProfile.systemPrompt;
      }
    }
    const split = BOT_PRACTICAL_MODEL_SPLIT[r.name] || {
      model: 'gemini-4-argon-low',
      effort: 'low',
      fallbackModel: 'gemini-3.8-flash-low'
    };
    if (!r.model) r.model = split.model;
    if (!r.effort) r.effort = split.effort;
    r.fallbackModel = r.fallbackModel || split.fallbackModel;
  }
  for (const [agentId, entries] of Object.entries(state.transcripts)) {
    if (!Array.isArray(entries)) continue;
    const cleaned = entries.filter((e) => {
      const txt = e.content || (e.message && e.message.content) || '';
      if (
        typeof txt === 'string' &&
        (txt.startsWith('Could not complete request via Antigravity CLI: Command failed:') ||
         txt.startsWith('⚠️ Task timed out before finishing.'))
      ) {
        return false;
      }
      if (e.message && e.message.type === 'widget' && e.message.widget && e.message.widget.prompt === 'Question?') {
        return false;
      }
      if (e.role === 'user' && e.content === 'Option A') {
        return false;
      }
      if (e.kind === 'user-attachment' && !e.localRelPath) {
        const rel = resolveAssetRelPath(e.file_path || e.originalUrl);
        if (rel) e.localRelPath = rel;
      }
      if (e.message) {
        if (e.message.type === 'attachment' && !e.message.localRelPath) {
          const rel = resolveAssetRelPath(e.message.url || e.message.originalUrl);
          if (rel) e.message.localRelPath = rel;
        }
        if (Array.isArray(e.message.images)) {
          for (const im of e.message.images) {
            if (!im.localRelPath || im.localRelPath.includes('grok-cache')) {
              const rel = resolveAssetRelPath(im.originalUrl || im.url);
              if (rel) im.localRelPath = rel;
            }
          }
        }
      }
      return true;
    });
    if (cleaned.length !== entries.length) {
      state.transcripts[agentId] = cleaned;
    }
    const row = (state.roster || []).find((r) => r.id === agentId);
    if (row && state.transcripts[agentId].length > 0) {
      const lastMsg = [...state.transcripts[agentId]].reverse().find((m) => m.content || (m.message && m.message.content));
      if (lastMsg) {
        const preview = (lastMsg.content || (lastMsg.message && lastMsg.message.content) || '').slice(0, 180);
        row.lastEntry = { kind: 'text', text: preview };
      }
    }
  }
}

function recalculateAndWriteTokenCostLedger(state) {
  if (!state || !Array.isArray(state.roster) || !state.transcripts) return;
  let totalTurns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  const isProEffort = appSettings.effort === 'medium' || appSettings.effort === 'high';
  const inputRatePerM = isProEffort ? 1.25 : 0.30;
  const outputRatePerM = isProEffort ? 5.0 : 1.50;

  for (const bot of state.roster) {
    const entries = state.transcripts[bot.id] || [];
    const sysPromptTokens = Math.ceil(((bot.systemPrompt || bot.description || '').length || 320) / 4);
    let botTurns = 0;
    let botIn = 0;
    let botOut = 0;
    let botCost = 0;
    let rollingContextTokens = sysPromptTokens;

    for (const e of entries) {
      const txt = e.content || (e.message && e.message.content) || '';
      const tok = Math.ceil((txt.length || 40) / 4);
      const isUser = e.role === 'user' && !e.fromAgent;
      if (isUser) {
        rollingContextTokens += tok;
      } else if (txt) {
        botTurns += 1;
        if (e.usage && e.usage.totalTokens) {
          botIn += e.usage.inputTokens;
          botOut += e.usage.outputTokens;
          botCost += e.usage.costUsd;
        } else {
          const turnIn = Math.min(rollingContextTokens + 250, 14000);
          const turnOut = tok;
          const turnCost = (turnIn / 1_000_000) * inputRatePerM + (turnOut / 1_000_000) * outputRatePerM;
          e.usage = {
            inputTokens: turnIn,
            outputTokens: turnOut,
            totalTokens: turnIn + turnOut,
            costUsd: Number(turnCost.toFixed(6))
          };
          botIn += turnIn;
          botOut += turnOut;
          botCost += turnCost;
        }
        rollingContextTokens += tok;
      }
    }

    bot.usage = {
      turns: botTurns,
      inputTokens: botIn,
      outputTokens: botOut,
      totalTokens: botIn + botOut,
      costUsd: Number(botCost.toFixed(4))
    };

    totalTurns += botTurns;
    totalInputTokens += botIn;
    totalOutputTokens += botOut;
    totalCostUsd += botCost;
  }

  state.studioUsage = {
    totalTurns,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    updatedAtIso: new Date().toISOString()
  };

  try {
    const sorted = [...state.roster].sort(
      (a, b) => ((b.usage && b.usage.totalTokens) || 0) - ((a.usage && a.usage.totalTokens) || 0)
    );
    const rowsMd = sorted
      .map((r) => {
        const u = r.usage || { turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
        return `| **${r.name}** | ${r.isGroup ? 'Group' : r.title || 'Bot'} | ${u.turns} | ${u.inputTokens.toLocaleString()} | ${u.outputTokens.toLocaleString()} | **${u.totalTokens.toLocaleString()}** | **$${u.costUsd.toFixed(4)}** |`;
      })
      .join('\n');

    const md = `# Grav Bot — Multi-Agent Token & Cost Estimates
**Estimates only; excludes provider tool use and subscription limits. Not a spending cap.**\n**Updated:** ${new Date().toLocaleString()}
**Total Bot Turns:** ${totalTurns.toLocaleString()} · **Total Input Tokens:** ${totalInputTokens.toLocaleString()} · **Total Output Tokens:** ${totalOutputTokens.toLocaleString()} · **Grand Total Tokens:** ${(totalInputTokens + totalOutputTokens).toLocaleString()} · **Estimated Total Cost:** **$${totalCostUsd.toFixed(4)}**

| Bot / Room | Role | Turns | Input Tokens | Output Tokens | Total Tokens | Est. Cost (USD) |
|---|---|---:|---:|---:|---:|---:|
${rowsMd}
| **STUDIO TOTAL (21 Seats)** | — | **${totalTurns}** | **${totalInputTokens.toLocaleString()}** | **${totalOutputTokens.toLocaleString()}** | **${(totalInputTokens + totalOutputTokens).toLocaleString()}** | **$${totalCostUsd.toFixed(4)}** |
`;
    fs.writeFileSync(path.join(WORKSPACE_DIR, 'TOKEN_COST_LOG.md'), md, 'utf8');
  } catch (e) {}
}

function saveAppState() {
  try {
    recalculateAndWriteTokenCostLedger(appState);
    fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2), 'utf8');
    emitRendererEvent('usage-updated', {
      studioUsage: appState.studioUsage,
      roster: appState.roster
    });
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

function saveAppSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

function emitRendererEvent(type, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gb:event', { type, data });
  }
}

const SKIP_DROP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.DS_Store', '.next', 'dist']);
const TEXT_SNIPPET_EXTS = new Set([
  '.md', '.txt', '.js', '.ts', '.jsx', '.tsx', '.py', '.html', '.css',
  '.json', '.yml', '.yaml', '.sh', '.sql', '.log', '.csv', '.xml', '.svg'
]);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

function resolveVirtualOrWorkspaceFile(relOrAbsPath) {
  const raw = String(relOrAbsPath || '').trim();
  if (!raw) return { full: '', webRel: '' };
  const dropped = raw.startsWith('@dropped/');
  const roots = dropped ? [DROPPED_DIR] : [WORKSPACE_DIR, APP_WORKSPACE_DIR, DROPPED_DIR];
  const local = dropped ? raw.slice('@dropped/'.length) : raw;
  for (const root of roots) {
    const full = path.resolve(root, local);
    const relative = path.relative(root, full);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    if (!fs.existsSync(full)) continue;
    const realRoot = fs.realpathSync(root);
    const realFull = fs.realpathSync(full);
    const realRelative = path.relative(realRoot, realFull);
    if (realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) continue;
    return { full: realFull, webRel: (root === DROPPED_DIR ? '@dropped/' : '') + relative.split(path.sep).join('/') };
  }
  return { full: '', webRel: '' };
}

function copyDroppedSafeSync(src, dest, depth = 0) {
  if (depth > 8 || !fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP_DROP_DIRS.has(entry.name)) continue;
      const sPath = path.join(src, entry.name);
      const dPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDroppedSafeSync(sPath, dPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const fStat = fs.statSync(sPath);
          if (fStat.size <= 40 * 1024 * 1024) {
            fs.copyFileSync(sPath, dPath);
          }
        } catch (e) {}
      }
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (stat.size <= 40 * 1024 * 1024) {
      fs.copyFileSync(src, dest);
    }
  }
}

function scanDirectoryForDropMeta(rootDir, webRelPrefix) {
  const files = [];
  const images = [];
  const htmlFiles = [];
  const textSnippets = [];
  let totalSize = 0;

  function walk(currDir, subPrefix, depth) {
    if (depth > 7 || !fs.existsSync(currDir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currDir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DROP_DIRS.has(entry.name)) continue;
      const full = path.join(currDir, entry.name);
      const subPath = subPrefix ? `${subPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, subPath, depth + 1);
      } else if (entry.isFile()) {
        let fStat;
        try {
          fStat = fs.statSync(full);
        } catch (e) {
          continue;
        }
        totalSize += fStat.size;
        const ext = path.extname(entry.name).toLowerCase();
        const relPath = `${webRelPrefix}/${subPath}`;
        const url = `http://127.0.0.1:${DAEMON_PORT}/workspace/${encodeURI(relPath)}`;
        const isImage = IMAGE_EXTS.has(ext);
        const isHtml = ext === '.html';
        const fileItem = {
          relPath,
          subPath,
          name: entry.name,
          ext,
          size: fStat.size,
          isImage,
          isHtml,
          url
        };
        if (files.length < 150) {
          files.push(fileItem);
        }
        if (isImage && images.length < 8) {
          images.push({
            relPath,
            url,
            alt: subPath
          });
        }
        if (isHtml && htmlFiles.length < 10) {
          htmlFiles.push({
            relPath,
            url,
            name: subPath
          });
        }
        if (TEXT_SNIPPET_EXTS.has(ext) && textSnippets.length < 6 && fStat.size <= 150 * 1024) {
          try {
            const rawText = fs.readFileSync(full, 'utf8');
            textSnippets.push({
              subPath,
              content: rawText.slice(0, 2200)
            });
          } catch (e) {}
        }
      }
    }
  }

  walk(rootDir, '', 0);
  return { files, images, htmlFiles, textSnippets, totalSize, fileCount: files.length };
}

function inspectTargetForDrop(rawTarget, statusTag = '') {
  let cleanPath = String(rawTarget || '').trim();
  if (!cleanPath) return null;
  if (cleanPath.startsWith('file://')) {
    try {
      cleanPath = fileURLToPath(cleanPath);
    } catch (e) {
      cleanPath = decodeURIComponent(cleanPath.replace(/^file:\/\//, ''));
    }
  }
  if (!path.isAbsolute(cleanPath)) {
    const resolved = resolveVirtualOrWorkspaceFile(cleanPath);
    if (resolved.full && fs.existsSync(resolved.full)) {
      cleanPath = resolved.full;
    }
  }
  if (!fs.existsSync(cleanPath)) return null;

  const stat = fs.statSync(cleanPath);
  const baseName = path.basename(cleanPath);
  const hash = crypto.createHash('sha1').update(cleanPath).digest('hex').slice(0, 10);
  const id = `drop-${hash}`;

  let stagedFull = cleanPath;
  let webRel = '';

  const relToWs = path.relative(WORKSPACE_DIR, cleanPath);
  const relToDrop = path.relative(DROPPED_DIR, cleanPath);

  if (!relToWs.startsWith('..') && !path.isAbsolute(relToWs)) {
    webRel = relToWs.split(path.sep).join('/');
  } else if (!relToDrop.startsWith('..') && !path.isAbsolute(relToDrop)) {
    webRel = `@dropped/${relToDrop.split(path.sep).join('/')}`;
  } else {
    const safeBase = baseName.replace(/[^a-zA-Z0-9._ -]/g, '_');
    let destName = safeBase;
    const candidateDest = path.join(DROPPED_DIR, destName);
    const existingRecord = droppedItems.find((x) => x.relPath === `@dropped/${destName}` && x.absPath !== cleanPath);
    if (existingRecord) {
      const ext = path.extname(safeBase);
      const stem = ext ? safeBase.slice(0, -ext.length) : safeBase;
      destName = `${stem}-${hash.slice(0, 5)}${ext}`;
    }
    stagedFull = path.join(DROPPED_DIR, destName);
    copyDroppedSafeSync(cleanPath, stagedFull, 0);
    webRel = `@dropped/${destName}`;
  }

  const existing = droppedItems.find((x) => x.id === id || x.relPath === webRel);
  const resolvedTag = statusTag || (existing && existing.statusTag) || '';

  if (stat.isDirectory()) {
    const meta = scanDirectoryForDropMeta(stagedFull, webRel);
    const item = {
      id,
      name: baseName,
      absPath: cleanPath,
      stagedPath: stagedFull,
      relPath: webRel,
      isDirectory: true,
      statusTag: resolvedTag,
      addedAt: Date.now(),
      fileCount: meta.fileCount,
      size: meta.totalSize,
      files: meta.files,
      images: meta.images,
      htmlFiles: meta.htmlFiles,
      textSnippets: meta.textSnippets
    };
    const idx = droppedItems.findIndex((x) => x.id === id || x.relPath === webRel);
    if (idx >= 0) {
      droppedItems[idx] = item;
    } else {
      droppedItems.unshift(item);
    }
    saveDroppedManifest();
    return item;
  } else {
    const ext = path.extname(baseName).toLowerCase();
    const isImage = IMAGE_EXTS.has(ext);
    const isHtml = ext === '.html';
    const url = `http://127.0.0.1:${DAEMON_PORT}/workspace/${encodeURI(webRel)}`;
    const textSnippets = [];
    if (TEXT_SNIPPET_EXTS.has(ext) && stat.size <= 150 * 1024) {
      try {
        textSnippets.push({
          subPath: baseName,
          content: fs.readFileSync(stagedFull, 'utf8').slice(0, 3500)
        });
      } catch (e) {}
    }
    const fileEntry = {
      relPath: webRel,
      subPath: baseName,
      name: baseName,
      ext,
      size: stat.size,
      isImage,
      isHtml,
      url
    };
    const item = {
      id,
      name: baseName,
      absPath: cleanPath,
      stagedPath: stagedFull,
      relPath: webRel,
      isDirectory: false,
      statusTag: resolvedTag,
      addedAt: Date.now(),
      fileCount: 1,
      size: stat.size,
      ext,
      isImage,
      isHtml,
      url,
      files: [fileEntry],
      images: isImage ? [{ relPath: webRel, url, alt: baseName }] : [],
      htmlFiles: isHtml ? [{ relPath: webRel, url, name: baseName }] : [],
      textSnippets
    };
    const idx = droppedItems.findIndex((x) => x.id === id || x.relPath === webRel);
    if (idx >= 0) {
      droppedItems[idx] = item;
    } else {
      droppedItems.unshift(item);
    }
    saveDroppedManifest();
    return item;
  }
}

function getWorkspaceFileList(dir = WORKSPACE_DIR, prefix = '', includeDropped = true) {
  const results = [];
  if (fs.existsSync(dir)) {
    const skipDirs = new Set(['__pycache__', 'node_modules', 'venv', '.venv', 'data']);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || skipDirs.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...getWorkspaceFileList(full, rel, false));
      } else {
        const stat = fs.statSync(full);
        const ext = path.extname(entry.name).toLowerCase();
        results.push({
          path: rel,
          ext,
          url: `http://127.0.0.1:${DAEMON_PORT}/workspace/${encodeURI(rel)}`,
          fileUrl: encodeURI(`file://${full}`),
          size: stat.size,
          mtimeMs: stat.mtimeMs
        });
      }
    }
  }
  if (includeDropped && fs.existsSync(DROPPED_DIR)) {
    const droppedFiles = getWorkspaceFileList(DROPPED_DIR, '@dropped', false);
    for (const df of droppedFiles) {
      const parentItem = droppedItems.find((item) => df.path === item.relPath || df.path.startsWith(`${item.relPath}/`));
      if (parentItem && parentItem.statusTag) {
        df.statusTag = parentItem.statusTag;
      }
      results.push(df);
    }
  }
  return results;
}

function formatAttachmentsBlockForPrompt(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const blocks = attachments.map((att, i) => {
    const statusLabel = att.statusTag === 'working'
      ? ' [✓ WORKING EXAMPLE]'
      : att.statusTag === 'not-working'
        ? ' [✕ NOT WORKING / ISSUE]'
        : '';
    const kindLabel = att.isDirectory ? 'FOLDER' : 'FILE';
    const fileLines = (att.files || []).slice(0, 40).map((f) => `    - ${f.subPath || f.name} (${Math.max(1, Math.round((f.size || 0) / 1024))} KB)`).join('\n');
    const snippetLines = (att.textSnippets || []).slice(0, 5).map((sn) => `  --- File Content: ${sn.subPath} ---\n${sn.content}`).join('\n\n');
    return `${i + 1}. [${kindLabel}] ${att.name}${statusLabel}
  - Original Disk Path: ${att.absPath || att.relPath}
  - Staged Workspace Path: ${att.stagedPath || att.relPath}
  - File Count: ${att.fileCount || 1}
${fileLines ? `  - Files inside:\n${fileLines}\n` : ''}${snippetLines ? `\n${snippetLines}\n` : ''}`;
  });
  return `\n=== ATTACHED FOLDERS & FILES FROM USER ===\nThe user dragged and dropped the following folder(s)/file(s) into this conversation (note any [✓ WORKING EXAMPLE] vs [✕ NOT WORKING / ISSUE] tags):\n\n${blocks.join('\n')}\n`;
}

function buildAgentPrompt(agent, userText, recentEntries, responderAgent = null, currentAttachments = []) {
  const speaker = responderAgent || agent;
  const recentFormatted = recentEntries.slice(-12).map((e) => {
    const role = e.role || (e.kind === 'send-message' ? 'assistant' : 'user');
    const sender = e.fromAgent ? e.fromAgent.name : (e.senderName || (role === 'user' ? 'User' : speaker.name));
    const text = e.content || (e.message && e.message.content) || '';
    if (!text || text.startsWith('Could not complete request via Antigravity CLI:') || text.startsWith('⚠️ ')) {
      return '';
    }
    const attNote = Array.isArray(e.attachments) && e.attachments.length > 0
      ? `\n  [Attached: ${e.attachments.map((a) => `${a.isDirectory ? 'Folder' : 'File'} "${a.name}"${a.statusTag ? ` (${a.statusTag.toUpperCase()})` : ''} at ${a.absPath || a.relPath}`).join(', ')}]`
      : '';
    return `[${sender}]: ${text}${attNote}`;
  }).filter(Boolean).join('\n\n');

  const instructions = speaker.systemPrompt || speaker.description || `You are ${speaker.name}, a helpful AI Bot in Grav Bot.`;
  const attachmentSection = formatAttachmentsBlockForPrompt(currentAttachments);

  return `${instructions}

=== BOT CONTEXT ===
- Bot Name: ${speaker.name}
- Role: ${speaker.title || 'Bot'}
- Platform: Grav Bot (powered by Antigravity)
- Project Workspace: ${WORKSPACE_DIR}
- Dropped / Attached Examples Directory: ${DROPPED_DIR}
- Workspace: keep project writes inside the configured workspace or folders explicitly attached by the user.

${recentFormatted ? `=== RECENT CONVERSATION ===\n${recentFormatted}\n\n` : ''}${attachmentSection}=== MESSAGE FROM USER ===
${userText}

=== REPLY GUIDELINES (GEMINI PROCEDURAL STYLE) ===
Reply directly and naturally as ${speaker.name} in English only.
- Format your reply in clean **Gemini procedural style**:
  1. Use clear numbered section headers (e.g., \`### 1. Summary Heading\`) and well-spaced bullet points (\`- **Key Point:** Explanation\`).
  2. Write in crisp, human-friendly executive prose rather than dense coding/terminal dumps. Do NOT dump raw git SHA hashes or long \`absolute/local/paths\` file paths in plain text unless the user explicitly asks for commit hashes or code diffs.
  3. Reference files as clean markdown links using only the filename as the label (e.g., \`[BEAUTY_REVIEW_LOG.md](file://${WORKSPACE_DIR}/BEAUTY_REVIEW_LOG.md)\` without wrapping the label in backticks).
  4. When discussing visual assets, wireframes, or screenshots (such as \`b1-1-landing-1280.png\`, \`b2-revised-cost-card-beauty-gate.png\`, \`fleek-r4-17-animations-contact-sheet.webp\`, or \`b1.html\`), embed or mention the asset filename so it renders inline in chat.
- If you want to present clickable option buttons (a decision widget), include a block at the end:
  \`\`\`widget {"prompt": "Question?", "options": [{"label": "Option A", "value": "opt_a", "style": "primary"}]}\`\`\`
- If you want to hand off a message to another Bot, include:
  \`\`\`route {"toAgentName": "Bot Name", "content": "Message"}\`\`\``;
}

function runAntigravityCli(promptText, responderBot = null) {
  return new Promise((resolve) => {
    const agyBin = appSettings.agyPath || path.join(HOME, '.local', 'bin', 'agy');
    const env = {
      ...process.env,
      PATH: `${path.join(HOME, '.local', 'bin')}:${process.env.PATH || ''}`
    };

    if (!fs.existsSync(agyBin)) {
      return resolve({
        ok: false,
        text: `Antigravity CLI not found at ${agyBin}. Check Settings in the right panel.`
      });
    }

    const safePrompt = String(promptText || '').replace(/\0/g, '\\x00');
    const split = (responderBot && BOT_PRACTICAL_MODEL_SPLIT[responderBot.name]) || {};
    const primaryModel = (responderBot && responderBot.model) || split.model || 'gemini-4-argon-low';
    const fallbackModel = (responderBot && responderBot.fallbackModel) || split.fallbackModel || 'gemini-3.8-flash-low';
    const botEffort = (responderBot && responderBot.effort) || split.effort || appSettings.effort || 'low';

    const executeWithModel = (modelId, effortLevel, allowRetry) => {
      const args = [
        '-p',
        safePrompt,
        '--disable-slash-commands',
        `--model=${modelId}`,
        `--effort=${effortLevel}`
      ];
      if (appSettings.skipPermissions === true) {
        args.push('--dangerously-skip-permissions');
      } else {
        args.push('--sandbox', '--mode=plan');
      }

      const child = execFile(agyBin, args, {
        env,
        cwd: WORKSPACE_DIR,
        timeout: 240000,
        maxBuffer: 10 * 1024 * 1024
      }, (err, stdout, stderr) => {
        if (!err && stdout && stdout.trim()) {
          return resolve({ ok: true, text: stdout.trim(), usedModel: modelId });
        }
        if (stdout && stdout.trim()) {
          return resolve({ ok: true, text: stdout.trim(), usedModel: modelId });
        }
        if (allowRetry && fallbackModel && fallbackModel !== modelId) {
          return executeWithModel(fallbackModel, 'low', false);
        }
        let cleanErr = (stderr || '').trim();
        if (!cleanErr) {
          if (err && (err.killed || err.signal === 'SIGTERM')) {
            cleanErr = 'Task timed out before finishing. Ask the Bot to continue or break the task into smaller steps.';
          } else {
            cleanErr = `Process exited (${(err && err.code) || 'interrupted'}). Please try again.`;
          }
        }
        resolve({
          ok: false,
          text: `⚠️ ${cleanErr}`,
          usedModel: modelId
        });
      });
      child.stdin?.end();
    };

    executeWithModel(primaryModel, botEffort, false);
  });
}

function parseRichBlocks(rawText) {
  let cleanText = rawText;
  const widgets = [];
  const routes = [];

  cleanText = cleanText.replace(/```widget\s*([\s\S]*?)```/g, (_m, jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr.trim());
      if (parsed && parsed.prompt !== 'Question?') {
        widgets.push(parsed);
      }
    } catch (e) {}
    return '';
  });

  cleanText = cleanText.replace(/```route\s*([\s\S]*?)```/g, (_m, jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr.trim());
      if (parsed && parsed.toAgentName && parsed.toAgentName !== 'Bot Name') {
        routes.push(parsed);
      }
    } catch (e) {}
    return '';
  });

  return { cleanText: cleanText.trim(), widgets, routes };
}

function appendTranscriptEntry(agentId, entry) {
  if (!appState.transcripts[agentId]) {
    appState.transcripts[agentId] = [];
  }
  appState.transcripts[agentId].push(entry);

  const row = appState.roster.find((r) => r.id === agentId);
  if (row) {
    row.updatedAt = entry.timestampMs || Date.now();
    row.lastActivityAt = row.updatedAt;
    const previewText = entry.content || (entry.message && entry.message.content) || '';
    if (previewText) {
      row.lastEntry = {
        kind: 'text',
        text: previewText.slice(0, 180)
      };
    }
  }
  saveAppState();
  emitRendererEvent('transcript-updated', { agentId, entry });
}

async function handleSendMessage({ agentId, content, attachments = [], replyTo = null, replyQuote = null, isRoutedTurn = false, isResumedTurn = false, routeDepth = 0 }) {
  const agent = appState.roster.find((r) => r.id === agentId);
  if (!agent) throw new Error('Bot not found');

  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  let effectiveContent = String(content || '').trim();
  if (!effectiveContent && safeAttachments.length > 0) {
    const summaryLabels = safeAttachments.map((a) => {
      const tag = a.statusTag === 'working' ? ' [✓ Working]' : a.statusTag === 'not-working' ? ' [✕ Not Working]' : '';
      return `${a.isDirectory ? '📁' : '📄'} ${a.name}${tag}`;
    });
    effectiveContent = `Please inspect the attached item(s): ${summaryLabels.join(', ')}`;
  }

  if (!isRoutedTurn && !isResumedTurn) {
    const now = Date.now();
    const userEntry = {
      kind: 'message',
      id: `msg-${now}-u`,
      role: 'user',
      content: effectiveContent,
      attachments: safeAttachments.length > 0 ? safeAttachments : undefined,
      replyTo: replyTo || undefined,
      replyQuote: replyQuote || undefined,
      timestampMs: now
    };
    appendTranscriptEntry(agentId, userEntry);
  }

  // Determine responder if Group Room
  let responder = agent;
  if (agent.isGroup && Array.isArray(agent.memberIds) && agent.memberIds.length > 0) {
    const mentioned = agent.memberIds
      .map((mid) => appState.roster.find((r) => r.id === mid))
      .find((m) => m && effectiveContent.toLowerCase().includes(m.name.toLowerCase().split(' ')[0]));
    responder = mentioned || appState.roster.find((r) => r.id === agent.memberIds[0]) || agent;
  }

  emitRendererEvent('bot-status', { agentId, responderId: responder.id, state: 'thinking' });

  const history = appState.transcripts[agentId] || [];
  const prompt = buildAgentPrompt(agent, effectiveContent, history, responder, safeAttachments);
  const llmResult = await runAntigravityCli(prompt, responder);

  emitRendererEvent('bot-status', { agentId, responderId: responder.id, state: 'idle' });

  const { cleanText, widgets, routes } = llmResult.ok
    ? parseRichBlocks(llmResult.text)
    : { cleanText: llmResult.text, widgets: [], routes: [] };

  const usedModel = llmResult.usedModel || responder.model || 'gemini-4-argon-low';
  const isMediumOrHigh = usedModel.includes('medium') || usedModel.includes('high') || usedModel.includes('opus');
  const inputTokens = Math.ceil(prompt.length / 4);
  const outputTokens = Math.ceil((llmResult.text || '').length / 4);
  const costUsd = Number(
    (
      (inputTokens / 1_000_000) * (isMediumOrHigh ? 1.25 : 0.30) +
      (outputTokens / 1_000_000) * (isMediumOrHigh ? 5.0 : 1.50)
    ).toFixed(6)
  );

  const replyEntry = {
    kind: 'send-message',
    id: `msg-${Date.now()}-a`,
    senderAgentId: responder.id,
    senderName: responder.name,
    modelUsed: usedModel,
    message: {
      type: 'text',
      content: cleanText
    },
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd
    },
    timestampMs: Date.now()
  };
  appendTranscriptEntry(agentId, replyEntry);

  for (const w of widgets) {
    appendTranscriptEntry(agentId, {
      kind: 'send-message',
      id: `msg-${Date.now()}-w-${Math.random().toString(36).slice(2, 6)}`,
      senderAgentId: responder.id,
      senderName: responder.name,
      message: {
        type: 'widget',
        widget: w
      },
      timestampMs: Date.now()
    });
  }

  for (const rt of routes.slice(0, 2)) {
    const targetNameLower = (rt.toAgentName || '').toLowerCase().trim();
    const targetSeat = appState.roster.find(
      (r) =>
        r.name.toLowerCase() === targetNameLower ||
        (targetNameLower === 'cursor code crusher relay' && r.name === 'Antigravity Code Crusher Relay')
    );
    if (targetSeat) {
      appendTranscriptEntry(agentId, {
        kind: 'message',
        id: `msg-${Date.now()}-out`,
        role: 'assistant',
        content: rt.content,
        toAgent: { id: targetSeat.id, name: targetSeat.name },
        timestampMs: Date.now()
      });
      appendTranscriptEntry(targetSeat.id, {
        kind: 'message',
        id: `msg-${Date.now()}-in`,
        role: 'user',
        content: rt.content,
        fromAgent: { id: responder.id, name: responder.name },
        timestampMs: Date.now()
      });
      if (appSettings.autoRoute === true && routeDepth < 2 && targetSeat.id !== agentId) {
        setTimeout(() => {
          handleSendMessage({
            agentId: targetSeat.id,
            content: `[Routed from ${responder.name}]: ${rt.content}`,
            isRoutedTurn: true,
            routeDepth: routeDepth + 1
          }).catch(() => {});
        }, 400);
      }
    }
  }

  return { ok: llmResult.ok, replyEntry };
}

function startLocalDaemon() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const allowedHost = `127.0.0.1:${DAEMON_PORT}`;
    if (req.headers.host !== allowedHost || (req.headers.origin && req.headers.origin !== 'null' && req.headers.origin !== `http://${allowedHost}`)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    let url;
    try { url = new URL(req.url, `http://${allowedHost}`); } catch { res.writeHead(400); return res.end('Bad request'); }
    if (req.method === 'GET' && url.pathname.startsWith('/workspace/')) {
      let rel;
      try { rel = decodeURIComponent(url.pathname.slice('/workspace/'.length)); } catch { res.writeHead(400); return res.end('Bad path'); }
      const { full } = resolveVirtualOrWorkspaceFile(rel);
      if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      const ext = path.extname(full).toLowerCase();
      const mimeMap = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.woff2': 'font/woff2',
        '.md': 'text/plain; charset=utf-8'
      };
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
      return res.end(fs.readFileSync(full));
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, app: 'Grav Bot', bots: appState.roster.length }));
    }
    if (req.method === 'POST') {
      res.writeHead(403);
      return res.end('Use the desktop composer.');
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  server.on('error', () => {});
  server.listen(DAEMON_PORT, '127.0.0.1');
}

function createMainWindow() {
  const savedBounds = (appSettings && appSettings.windowBounds) || {};
  let width = Math.max(900, Number(savedBounds.width) || 1320);
  let height = Math.max(600, Number(savedBounds.height) || 840);
  let x = typeof savedBounds.x === 'number' ? savedBounds.x : undefined;
  let y = typeof savedBounds.y === 'number' ? savedBounds.y : undefined;

  if (x !== undefined && y !== undefined) {
    try {
      const displays = screen.getAllDisplays();
      const onAnyDisplay = displays.some((d) => {
        const b = d.bounds;
        return x >= b.x - 100 && x < b.x + b.width - 100 && y >= b.y - 50 && y < b.y + b.height - 50;
      });
      if (!onAnyDisplay) {
        x = undefined;
        y = undefined;
      }
    } catch (e) {}
  }

  mainWindow = new BrowserWindow({
    show: process.env.GRAV_BOT_SMOKE_TEST !== '1',
    x,
    y,
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    title: 'Grav Bot',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#141414',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (savedBounds.isMaximized) {
    mainWindow.maximize();
  }

  let boundsSaveTimer = null;
  const persistWindowBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const isMaximized = mainWindow.isMaximized();
      const b = isMaximized ? (appSettings.windowBounds || mainWindow.getBounds()) : mainWindow.getBounds();
      appSettings.windowBounds = {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        isMaximized
      };
      saveAppSettings();
    }, 300);
  };

  mainWindow.on('resize', persistWindowBounds);
  mainWindow.on('move', persistWindowBounds);

  // Prevent Electron from navigating away when folders or files are dragged and dropped onto the window
  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    if (!navUrl.endsWith('/renderer/index.html')) {
      event.preventDefault();
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const iconPath = path.join(__dirname, 'renderer', 'gravbot-icon.svg');
  if (process.platform === 'darwin' && app.dock && fs.existsSync(iconPath)) {
    try {
      const img = nativeImage.createFromBuffer(fs.readFileSync(iconPath));
      if (img && !img.isEmpty()) app.dock.setIcon(img);
    } catch (e) {}
  }

  ensureDirectoriesAndState();
  startLocalDaemon();
  createMainWindow();

  // Auto-resume any user turns that were interrupted if Grav Bot was reset/restarted during a build
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (appSettings.autoResume !== true || !appState || !Array.isArray(appState.roster) || !appState.transcripts) return;
        const now = Date.now();
        const MAX_RESUME_AGE_MS = 30 * 60 * 1000;
        let delayMs = 400;
        for (const seat of appState.roster) {
          const entries = appState.transcripts[seat.id] || [];
          if (entries.length === 0) continue;
          const lastEntry = entries[entries.length - 1];
          const isUnansweredUserTurn =
            lastEntry &&
            lastEntry.role === 'user' &&
            !lastEntry.fromAgent &&
            typeof lastEntry.content === 'string' &&
            lastEntry.content.trim().length > 0 &&
            lastEntry.timestampMs &&
            now - lastEntry.timestampMs <= MAX_RESUME_AGE_MS;
          if (isUnansweredUserTurn) {
            setTimeout(() => {
              handleSendMessage({
                agentId: seat.id,
                content: lastEntry.content,
                attachments: lastEntry.attachments || [],
                isResumedTurn: true
              }).catch(() => {});
            }, delayMs);
            delayMs += 1500;
          }
        }
      }, 1200);
    });
  }

  ipcMain.handle('gb:get-initial-state', async () => {
    return {
      appState,
      appSettings,
      workspaceDir: WORKSPACE_DIR,
      droppedDir: DROPPED_DIR,
      droppedItems,
      workspaceFiles: getWorkspaceFileList()
    };
  });

  ipcMain.handle('gb:send-message', async (_e, payload) => {
    return handleSendMessage(payload);
  });

  ipcMain.handle('gb:toggle-reaction', async (_e, { agentId, entryId, emoji }) => {
    const entries = appState.transcripts[agentId] || [];
    const target = entries.find((e) => e.id === entryId);
    if (!target || !emoji) return { ok: false };
    if (!Array.isArray(target.reactions)) {
      target.reactions = [];
    }
    const existingIdx = target.reactions.findIndex((r) => r.emoji === emoji && (r.by === 'me' || r.by === 'user'));
    if (existingIdx >= 0) {
      target.reactions.splice(existingIdx, 1);
    } else {
      target.reactions.push({ emoji, by: 'me' });
    }
    if (target.reactions.length === 0) {
      delete target.reactions;
    }
    saveAppState();
    return { ok: true, reactions: target.reactions || [] };
  });

  ipcMain.handle('gb:respond-widget', async (_e, { agentId, entryId, value, label }) => {
    const entries = appState.transcripts[agentId] || [];
    const target = entries.find((e) => e.id === entryId);
    if (target) {
      target.respondedValue = value;
      saveAppState();
    }
    return handleSendMessage({
      agentId,
      content: label || value
    });
  });

  ipcMain.handle('gb:create-bot', async (_e, payload) => {
    const id = crypto.randomUUID();
    const isGroup = Boolean(payload.isGroup);
    const newBot = {
      id,
      name: (payload.name || (isGroup ? 'New Group' : 'New Bot')).trim(),
      title: (payload.title || (isGroup ? 'Group' : 'Bot')).trim(),
      description: (payload.description || '').trim(),
      systemPrompt: (payload.systemPrompt || '').trim(),
      avatarShape: payload.avatarShape || 'blob',
      avatarColor: payload.avatarColor || 'blue',
      isPrimary: false,
      isPinned: Boolean(payload.isPinned),
      isGroup,
      memberIds: Array.isArray(payload.memberIds) ? payload.memberIds : [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
      lastEntry: {
        kind: 'text',
        text: payload.description || (isGroup ? 'Group conversation' : 'No messages yet')
      }
    };
    appState.roster.push(newBot);
    appState.transcripts[id] = [];
    saveAppState();
    emitRendererEvent('roster-updated', appState.roster);
    return { ok: true, bot: newBot };
  });

  ipcMain.handle('gb:update-bot', async (_e, { id, patch }) => {
    const bot = appState.roster.find((r) => r.id === id);
    if (!bot) return { ok: false, error: 'Bot not found' };
    Object.assign(bot, patch, { updatedAt: Date.now() });
    saveAppState();
    emitRendererEvent('roster-updated', appState.roster);
    return { ok: true, bot };
  });

  ipcMain.handle('gb:delete-bot', async (_e, id) => {
    if (id === appState.primaryBotId) {
      return { ok: false, error: 'Cannot delete the Primary Bot.' };
    }
    appState.roster = appState.roster.filter((r) => r.id !== id);
    delete appState.transcripts[id];
    saveAppState();
    emitRendererEvent('roster-updated', appState.roster);
    return { ok: true };
  });

  ipcMain.handle('gb:clear-transcript', async (_e, id) => {
    appState.transcripts[id] = [];
    const bot = appState.roster.find((r) => r.id === id);
    if (bot) {
      bot.lastEntry = { kind: 'text', text: 'No messages yet' };
    }
    saveAppState();
    emitRendererEvent('roster-updated', appState.roster);
    return { ok: true };
  });

  ipcMain.handle('gb:set-primary-bot', async (_e, id) => {
    appState.primaryBotId = id;
    for (const r of appState.roster) {
      r.isPrimary = r.id === id;
      if (r.id === id) r.isPinned = true;
    }
    saveAppState();
    emitRendererEvent('roster-updated', appState.roster);
    return { ok: true, primaryBotId: id };
  });

  ipcMain.handle('gb:reset-studio-mode', async (_e, mode) => {
    if (mode === 'fresh') {
      appState = getFreshDefaultState();
    } else {
      appState = loadBundledCharactersSeed();
    }
    saveAppState();
    emitRendererEvent('state-reset', appState);
    return { ok: true, appState };
  });

  ipcMain.handle('gb:read-workspace-file', async (_e, relPath) => {
    const { full, webRel } = resolveVirtualOrWorkspaceFile(relPath);
    if (!full || !fs.existsSync(full)) return { ok: false, error: 'File not found' };
    if (fs.statSync(full).isDirectory()) {
      const meta = scanDirectoryForDropMeta(full, webRel);
      const listing = meta.files.map((f) => `${f.subPath} (${Math.max(1, Math.round(f.size / 1024))} KB)`).join('\n');
      return {
        ok: true,
        path: webRel,
        ext: 'folder',
        isDirectory: true,
        isImage: false,
        isHtml: false,
        url: '',
        fileUrl: encodeURI(`file://${full}`),
        content: `Folder: ${webRel}\nTotal files: ${meta.fileCount}\n\n${listing}`
      };
    }
    const ext = path.extname(full).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext);
    const isHtml = ext === '.html';
    const url = `http://127.0.0.1:${DAEMON_PORT}/workspace/${encodeURI(webRel)}`;
    const fileUrl = encodeURI(`file://${full}`);
    let content = '';
    if (!isImage || ext === '.svg') {
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch (e) {}
    }
    return { ok: true, path: webRel, ext, isImage, isHtml, url, fileUrl, content };
  });

  ipcMain.handle('gb:reveal-workspace-file', async (_e, { relPath, mode }) => {
    const { full, webRel } = resolveVirtualOrWorkspaceFile(relPath || '');
    if (!full || !fs.existsSync(full)) return { ok: false };
    if (mode === 'browser') {
      await shell.openExternal(`http://127.0.0.1:${DAEMON_PORT}/workspace/${encodeURI(webRel)}`);
    } else {
      shell.showItemInFolder(full);
    }
    return { ok: true };
  });

  ipcMain.handle('gb:list-workspace-files', async () => {
    return getWorkspaceFileList();
  });

  ipcMain.handle('gb:ingest-dropped-paths', async (_e, { paths = [], statusTag = '' } = {}) => {
    const ingested = [];
    for (const rawPath of paths) {
      try {
        const item = inspectTargetForDrop(rawPath, statusTag);
        if (item) ingested.push(item);
      } catch (err) {
        console.error('Failed to ingest dropped path:', rawPath, err);
      }
    }
    const workspaceFiles = getWorkspaceFileList();
    emitRendererEvent('workspace-files-updated', { droppedItems, workspaceFiles });
    return { ok: true, items: ingested, droppedItems, workspaceFiles };
  });

  ipcMain.handle('gb:ingest-dropped-entries', async (_e, { entries = [], statusTag = '' } = {}) => {
    const roots = new Set();
    for (const ent of entries) {
      if (!ent || !ent.relPath) continue;
      const safeRel = path.normalize(ent.relPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const topSegment = safeRel.split(path.sep)[0];
      if (topSegment) roots.add(topSegment);
      const targetFull = path.join(DROPPED_DIR, safeRel);
      if (ent.isDirectory) {
        fs.mkdirSync(targetFull, { recursive: true });
      } else if (typeof ent.base64 === 'string') {
        fs.mkdirSync(path.dirname(targetFull), { recursive: true });
        fs.writeFileSync(targetFull, Buffer.from(ent.base64, 'base64'));
      }
    }
    const ingested = [];
    for (const rootName of roots) {
      const fullRoot = path.join(DROPPED_DIR, rootName);
      if (fs.existsSync(fullRoot)) {
        const item = inspectTargetForDrop(fullRoot, statusTag);
        if (item) ingested.push(item);
      }
    }
    const workspaceFiles = getWorkspaceFileList();
    emitRendererEvent('workspace-files-updated', { droppedItems, workspaceFiles });
    return { ok: true, items: ingested, droppedItems, workspaceFiles };
  });

  ipcMain.handle('gb:pick-files-or-folders', async (_e, { statusTag = '' } = {}) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Folders or Files to Attach & Inspect in Grav Bot',
      buttonLabel: 'Attach to Grav Bot',
      properties: ['openFile', 'openDirectory', 'multiSelections', 'createDirectory']
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const ingested = [];
    for (const p of res.filePaths) {
      const item = inspectTargetForDrop(p, statusTag);
      if (item) ingested.push(item);
    }
    const workspaceFiles = getWorkspaceFileList();
    emitRendererEvent('workspace-files-updated', { droppedItems, workspaceFiles });
    return { ok: true, items: ingested, droppedItems, workspaceFiles };
  });

  ipcMain.handle('gb:set-dropped-item-tag', async (_e, { id, relPath, statusTag = '' }) => {
    const target = droppedItems.find((x) => (id && x.id === id) || (relPath && x.relPath === relPath));
    if (target) {
      target.statusTag = statusTag;
      saveDroppedManifest();
    }
    const workspaceFiles = getWorkspaceFileList();
    emitRendererEvent('workspace-files-updated', { droppedItems, workspaceFiles });
    return { ok: true, item: target, droppedItems, workspaceFiles };
  });

  ipcMain.handle('gb:remove-dropped-item', async (_e, { id, relPath }) => {
    const idx = droppedItems.findIndex((x) => (id && x.id === id) || (relPath && x.relPath === relPath));
    if (idx >= 0) {
      const removed = droppedItems[idx];
      droppedItems.splice(idx, 1);
      saveDroppedManifest();
      if (removed.stagedPath && removed.stagedPath.startsWith(DROPPED_DIR) && fs.existsSync(removed.stagedPath)) {
        try {
          fs.rmSync(removed.stagedPath, { recursive: true, force: true });
        } catch (e) {}
      }
    }
    const workspaceFiles = getWorkspaceFileList();
    emitRendererEvent('workspace-files-updated', { droppedItems, workspaceFiles });
    return { ok: true, droppedItems, workspaceFiles };
  });

  ipcMain.handle('gb:update-settings', async (_e, patch) => {
    appSettings = { ...appSettings, ...patch };
    saveAppSettings();
    return { ok: true, appSettings };
  });

  ipcMain.handle('gb:start-native-dictation', async () => {
    try {
      Menu.sendActionToFirstResponder('startDictation:');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Private language-server credential discovery is excluded from the public preview.
  for (const channel of ['gb:voice-stream-start', 'gb:voice-stream-chunk', 'gb:voice-stream-stop', 'gb:transcribe-audio']) {
    ipcMain.handle(channel, async () => ({ ok: false, error: 'Use macOS Dictation for voice input in this preview.' }));
  }

  ipcMain.handle('gb:open-external-path', async (_e, targetPath) => {
    if (targetPath.startsWith('http://') || targetPath.startsWith('https://')) {
      await shell.openExternal(targetPath);
    } else {
      await shell.showItemInFolder(targetPath);
    }
    return { ok: true };
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
