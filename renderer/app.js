import { createActor, mapShapeToBody, makeAppearance, renderSvgString, createAvatarController, resolveAvatar } from './avatar-engine.mjs';

// Grav Bot's 26 shapes and 11 colors
const BOT_SHAPES = [
  'blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet',
  'capsule', 'cylinder', 'hex', 'gem', 'crystal', 'wedge',
  'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf',
  'square', 'sparkle', 'clover', 'flower', 'heart', 'house',
  'star', 'pumpkin'
];

// In Grav Bot's dark theme, "black" renders as bright ivory/white (#F2F2F2) so it stands out with dark cutout eyes
const DARK_THEME_INK = {
  black: '#F2F2F2',
  brown: '#B07B48',
  red: '#FF3B4E',
  orange: '#FF771A',
  yellow: '#FFAA00',
  green: '#00D67A',
  cyan: '#00CDBD',
  blue: '#2690FF',
  violet: '#9E6BFF',
  magenta: '#FF42A8',
  gray: '#949499'
};

const COLOR_SWATCHES = [
  { id: 'black', label: 'Black / Ivory', hex: '#F2F2F2' },
  { id: 'blue', label: 'Blue', hex: '#2690FF' },
  { id: 'cyan', label: 'Cyan', hex: '#00CDBD' },
  { id: 'green', label: 'Green', hex: '#00D67A' },
  { id: 'yellow', label: 'Yellow', hex: '#FFAA00' },
  { id: 'orange', label: 'Orange', hex: '#FF771A' },
  { id: 'red', label: 'Red', hex: '#FF3B4E' },
  { id: 'magenta', label: 'Magenta', hex: '#FF42A8' },
  { id: 'violet', label: 'Violet', hex: '#9E6BFF' },
  { id: 'brown', label: 'Brown', hex: '#B07B48' },
  { id: 'gray', label: 'Gray', hex: '#949499' }
];

let state = {
  roster: [],
  transcripts: {},
  primaryBotId: '',
  activeSeatId: '',
  settings: {},
  workspaceDir: '',
  droppedDir: '',
  droppedItems: [],
  pendingAttachments: [],
  expandedDroppedFolders: {},
  workspaceFiles: [],
  seatFilter: '',
  threadSearch: '',
  botStatusBySeat: {},
  unreadDoneBySeat: {},
  scrollTopBySeat: {},
  draftBySeat: {},
  activeReplyTo: null, // { id, senderLabel, snippet }
  modalMode: 'bot', // 'bot' | 'group'
  modalShape: 'blob',
  modalColor: 'blue'
};

function showStatusToast(title, subtitle = '') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'completion-toast';
  toast.innerHTML = `
    <span class="bot-done-dot"></span>
    <div>
      <div style="font-weight:600;">${escapeHtml(title)}</div>
      ${subtitle ? `<div style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(subtitle)}</div>` : ''}
    </div>
  `;
  toast.addEventListener('click', () => toast.remove());
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

function playCompletionChime() {
  if (state.settings.soundEffects === false) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.04, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
    oscillator.start(); oscillator.stop(audio.currentTime + 0.12);
    oscillator.onended = () => audio.close();
  } catch {}
}

function showCompletionToast(seat, previewText) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'completion-toast';
  const snippet = String(previewText || 'Task complete').replace(/\s+/g, ' ').slice(0, 70);
  toast.innerHTML = `
    <span class="bot-done-dot"></span>
    <div>
      <div style="font-weight:600;">${escapeHtml(seat.name)} finished</div>
      <div style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(snippet)}</div>
    </div>
  `;
  toast.addEventListener('click', () => {
    selectSeat(seat.id);
    toast.remove();
  });
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 5500);

  // Also trigger native macOS notification if window is in background
  try {
    if (document.hidden && 'Notification' in window) {
      new Notification(`${seat.name} finished`, { body: snippet });
    }
  } catch (e) {}
}

function syncThinkingBar() {
  const thinkingBar = document.getElementById('thinkingBar');
  if (!thinkingBar) return;
  const activeId = state.activeSeatId;
  const currentStatus = state.botStatusBySeat[activeId];
  if (currentStatus === 'thinking') {
    const seat = getSeatById(activeId);
    const av = getSeatResolvedAvatar(seat);
    thinkingBar.style.display = 'flex';
    document.getElementById('thinkingLabel').textContent = `${seat ? seat.name : 'Bot'} is thinking…`;
    mountAnimatedAvatar('thinking-bar-mark', document.getElementById('thinkingAvatarSlot'), {
      id: seat ? seat.id : 'thinking',
      shape: av.shape,
      colorId: av.color,
      sizePx: 26,
      animState: 'thinking',
      followPointer: false
    });
  } else {
    thinkingBar.style.display = 'none';
  }
}

// Track active animated avatar controllers so we can clean them up cleanly
const activeControllers = new Map();

function getSeatResolvedAvatar(seat) {
  if (!seat) return { shape: 'blob', color: 'blue', ink: DARK_THEME_INK.blue };
  const resolved = resolveAvatar({
    agentId: seat.id || 'default',
    avatarShape: BOT_SHAPES.includes(seat.avatarShape) ? seat.avatarShape : undefined,
    avatarColor: DARK_THEME_INK[seat.avatarColor] ? seat.avatarColor : undefined
  });
  const shape = BOT_SHAPES.includes(seat.avatarShape) ? seat.avatarShape : resolved.shape;
  const color = DARK_THEME_INK[seat.avatarColor] ? seat.avatarColor : resolved.color;
  return {
    shape,
    color,
    ink: DARK_THEME_INK[color] || DARK_THEME_INK.blue
  };
}

// Render an original vector avatar.
const svgCache = new Map();
function getStaticBotSvg(shape, colorId, sizePx = 34, uid = 'mark') {
  const safeShape = BOT_SHAPES.includes(shape) ? shape : 'blob';
  const ink = DARK_THEME_INK[colorId] || DARK_THEME_INK.blue;
  const cacheKey = `${safeShape}:${colorId}:${sizePx}`;
  let cached = svgCache.get(cacheKey);
  if (!cached) {
    const body = mapShapeToBody(safeShape);
    const actor = createActor({ body });
    // Advance slightly so eyes are open in neutral pose
    actor.advance(0.05);
    const appearance = makeAppearance(ink);
    cached = renderSvgString(actor.frame(), appearance, sizePx, `gb-${safeShape}-${colorId}-${sizePx}`);
    svgCache.set(cacheKey, cached);
  }
  // Ensure unique SVG mask IDs per DOM instance
  const uniqueId = `gb-${uid}-${Math.random().toString(36).slice(2, 7)}`;
  return cached.replaceAll(`gb-${safeShape}-${colorId}-${sizePx}`, uniqueId);
}

// Mount an original SVG avatar with lightweight motion.
function mountAnimatedAvatar(key, containerEl, { id, shape, colorId, sizePx = 36, animState = 'idle', followPointer = true }) {
  if (!containerEl) return null;
  if (activeControllers.has(key)) {
    try { activeControllers.get(key).detach(); } catch (e) {}
    activeControllers.delete(key);
  }
  containerEl.innerHTML = '';
  const safeShape = BOT_SHAPES.includes(shape) ? shape : 'blob';
  const ink = DARK_THEME_INK[colorId] || DARK_THEME_INK.blue;
  const ctrl = createAvatarController({
    id: id || key,
    seed: id || key,
    body: mapShapeToBody(safeShape),
    appearance: makeAppearance(ink),
    state: animState,
    size: sizePx,
    fill: 0.92,
    resolution: 192,
    isPlaying: true,
    isFollowingPointer: followPointer
  });
  const detach = ctrl.attach({ host: containerEl, canvas: containerEl });
  activeControllers.set(key, { ctrl, detach });
  return ctrl;
}

function getSeatById(id) {
  return state.roster.find((r) => r.id === id);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildFilePillHtml(labelRaw, urlRaw) {
  let cleanUrl = String(urlRaw || '').trim();
  let decodedPath = cleanUrl;
  try {
    decodedPath = decodeURIComponent(cleanUrl.replace(/^file:\/\//, ''));
  } catch (e) {}
  const baseName = decodedPath.split('/').filter(Boolean).pop() || labelRaw || 'file';
  let cleanLabel = String(labelRaw || baseName)
    .replace(/^`+|`+$/g, '')
    .replace(/&lt;|&gt;/g, '')
    .trim();
  if (!cleanLabel || cleanLabel.startsWith('file://') || cleanLabel.length > 64) {
    cleanLabel = baseName;
  }
  const ext = (baseName.includes('.') ? baseName.split('.').pop() : '').toLowerCase();
  let badgeText = 'FILE';
  let badgeClass = '';
  if (ext === 'html' || ext === 'htm') { badgeText = '</>'; badgeClass = 'html'; }
  else if (ext === 'js' || ext === 'ts' || ext === 'jsx' || ext === 'tsx') { badgeText = 'JS'; badgeClass = 'js'; }
  else if (ext === 'py') { badgeText = 'PY'; badgeClass = 'py'; }
  else if (ext === 'md' || ext === 'txt') { badgeText = 'MD'; badgeClass = 'md'; }
  else if (['png', 'webp', 'svg', 'jpg', 'jpeg', 'gif'].includes(ext)) { badgeText = 'IMG'; badgeClass = 'img'; }
  else if (ext === 'css') { badgeText = 'CSS'; badgeClass = 'html'; }
  else if (ext === 'json') { badgeText = '{ }'; badgeClass = 'js'; }

  return `<a class="gb-file-pill" href="#" data-gb-file="${escapeHtml(decodedPath)}" title="${escapeHtml(decodedPath)}"><span class="gb-file-pill-badge ${badgeClass}">${escapeHtml(badgeText)}</span><span>${escapeHtml(cleanLabel)}</span></a>`;
}

function formatInlineMarkdown(escapedLine) {
  let s = escapedLine;

  // 1. Markdown links where label may or may not have backticks: [`label`](url) or [label](url)
  s = s.replace(/\[`?([^\]`]+)`?\]\(\s*([^)]+?)\s*\)/g, (_m, label, url) => {
    const rawUrl = url.replace(/&amp;/g, '&').trim();
    if (rawUrl.startsWith('file://') || rawUrl.startsWith('/') || rawUrl.includes('/workspace/') || /\.(md|html|py|js|css|json|png|webp|svg|jpg)(#L\d+(?:-L?\d+)?)?$/i.test(rawUrl)) {
      const strippedHash = rawUrl.replace(/#L\d+(?:-L?\d+)?$/i, '');
      return buildFilePillHtml(label, strippedHash);
    }
    return `<a href="${escapeHtml(rawUrl)}" target="_blank" rel="noopener" style="color:#60A5FA;text-decoration:underline;">${label}</a>`;
  });

  // 2. Clean up any raw stray (file:///Users/...) or bare file:///Users/... URLs that spilled across lines
  s = s.replace(/\(?\bfile:\/\/\/[^\s)<]+(\)?)/g, (fullMatch) => {
    const cleaned = fullMatch.replace(/^\(|\)$/g, '').replace(/[.,;]+$/, '');
    return buildFilePillHtml('', cleaned);
  });

  // 3. Inline code `...`
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => {
    const trimmed = code.trim();
    if (/\.(html|png|webp|svg|md|py|js|css)$/i.test(trimmed) && !trimmed.includes(' ')) {
      return buildFilePillHtml(trimmed, trimmed);
    }
    return `<code>${code}</code>`;
  });

  // 4. Bold & Italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');

  return s;
}

function formatMessageHtml(raw) {
  if (!raw) return '';
  const codeBlocks = [];
  let text = String(raw).replace(/\r\n/g, '\n');

  // Extract fenced code blocks first
  text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`);
    return `@@GB_CODE_BLOCK_${idx}@@`;
  });

  const lines = text.split('\n');
  const out = [];
  let inUl = false;
  let inOl = false;
  let tableRows = [];

  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };

  const flushTable = () => {
    if (!tableRows.length) return;
    if (tableRows.length >= 2) {
      let html = '<div class="gb-md-table-wrap"><table class="gb-md-table"><thead><tr>';
      const headers = tableRows[0];
      headers.forEach((h) => { html += `<th>${formatInlineMarkdown(escapeHtml(h.trim()))}</th>`; });
      html += '</tr></thead><tbody>';
      for (let r = 1; r < tableRows.length; r++) {
        const rowCells = tableRows[r];
        if (rowCells.every((c) => /^[:\-\s]+$/.test(c))) continue;
        html += '<tr>';
        rowCells.forEach((c) => { html += `<td>${formatInlineMarkdown(escapeHtml(c.trim()))}</td>`; });
        html += '</tr>';
      }
      html += '</tbody></table></div>';
      out.push(html);
    } else {
      tableRows.forEach((r) => out.push(`<p>${formatInlineMarkdown(escapeHtml(r.join(' | ')))}</p>`));
    }
    tableRows = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^@@GB_CODE_BLOCK_(\d+)@@$/.test(trimmed)) {
      closeLists();
      flushTable();
      const idx = Number(trimmed.match(/^@@GB_CODE_BLOCK_(\d+)@@$/)[1]);
      out.push(codeBlocks[idx] || '');
      continue;
    }

    // Markdown table row
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
      closeLists();
      const cells = trimmed.slice(1, -1).split('|');
      tableRows.push(cells);
      continue;
    } else if (tableRows.length > 0) {
      flushTable();
    }

    if (!trimmed) {
      closeLists();
      continue;
    }

    // Headings
    const hMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (hMatch) {
      closeLists();
      const level = Math.min(4, hMatch[1].length);
      out.push(`<h${level}>${formatInlineMarkdown(escapeHtml(hMatch[2]))}</h${level}>`);
      continue;
    }

    // Numbered section heading like "1. **Title**" or ordered list item
    const olMatch = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (olMatch) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${formatInlineMarkdown(escapeHtml(olMatch[2]))}</li>`);
      continue;
    }

    // Bullet list item
    const ulMatch = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ulMatch) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${formatInlineMarkdown(escapeHtml(ulMatch[1]))}</li>`);
      continue;
    }

    closeLists();
    out.push(`<p>${formatInlineMarkdown(escapeHtml(trimmed))}</p>`);
  }

  closeLists();
  flushTable();

  let finalHtml = out.join('\n');
  finalHtml = finalHtml.replace(/@@GB_CODE_BLOCK_(\d+)@@/g, (_m, idx) => codeBlocks[Number(idx)] || '');
  return finalHtml;
}

function formatTimestamp(ms) {
  if (!ms) return '';
  try {
    const d = new Date(Number(ms));
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch (e) {
    return '';
  }
}

function renderSidebar() {
  const container = document.getElementById('rosterContainer');
  container.innerHTML = '';

  const filter = state.seatFilter.trim().toLowerCase();
  const filtered = state.roster.filter((r) => {
    if (!filter) return true;
    return (
      r.name.toLowerCase().includes(filter) ||
      (r.title || '').toLowerCase().includes(filter) ||
      (r.description || '').toLowerCase().includes(filter)
    );
  });

  const pinnedSeats = filtered.filter((r) => r.isPrimary || r.isPinned);
  const allBots = filtered.filter((r) => !r.isPrimary && !r.isPinned && !r.isGroup);
  const groupRooms = filtered.filter((r) => !r.isPrimary && !r.isPinned && r.isGroup);

  const appendSection = (label, rows) => {
    if (!rows.length) return;
    const hdr = document.createElement('div');
    hdr.className = 'sidebar-section-label';
    hdr.textContent = label;
    container.appendChild(hdr);

    rows.forEach((seat) => {
      const item = document.createElement('div');
      item.className = `roster-item ${seat.id === state.activeSeatId ? 'active' : ''}`;

      const av = getSeatResolvedAvatar(seat);
      const isWorking = state.botStatusBySeat[seat.id] === 'thinking';
      const isDoneUnread = Boolean(state.unreadDoneBySeat[seat.id]);
      const preview = isWorking
        ? 'Working on task…'
        : (seat.lastEntry?.text ||
           seat.description ||
           (seat.isGroup ? `${(seat.memberIds || []).length} Bots` : 'No messages yet'));

      let statusDotHtml = '';
      if (isWorking) {
        statusDotHtml = `<span class="bot-working-dot" title="Working…"></span>`;
      } else if (isDoneUnread) {
        statusDotHtml = `<span class="bot-done-dot" title="Task finished · New reply"></span>`;
      }

      item.innerHTML = `
        <div class="grok-mark-slot">${getStaticBotSvg(av.shape, av.color, 34, seat.id)}</div>
        <div class="roster-meta">
          <div class="roster-name-row">
            <span class="roster-name">${escapeHtml(seat.name)}</span>
            <span class="roster-badges">${statusDotHtml}</span>
          </div>
          <div class="roster-preview">${escapeHtml(preview)}</div>
        </div>
      `;

      item.addEventListener('click', () => selectSeat(seat.id));
      container.appendChild(item);
    });
  };

  appendSection('Pinned', pinnedSeats);
  appendSection('All Bots', allBots);
  appendSection('Groups', groupRooms);
}

function selectSeat(seatId) {
  const stream = document.getElementById('transcriptStream');
  const composer = document.getElementById('composerInput');
  if (state.activeSeatId && stream) {
    const isAtBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 60;
    state.scrollTopBySeat[state.activeSeatId] = isAtBottom ? 'bottom' : stream.scrollTop;
  }
  if (state.activeSeatId && composer) {
    state.draftBySeat[state.activeSeatId] = composer.value || '';
  }

  state.activeSeatId = seatId;
  try {
    localStorage.setItem('gravbot_active_seat_id', seatId);
  } catch (e) {}

  if (state.unreadDoneBySeat[seatId]) {
    delete state.unreadDoneBySeat[seatId];
  }
  if (composer) {
    composer.value = state.draftBySeat[seatId] || '';
    composer.style.height = 'auto';
    composer.style.height = `${Math.min(150, composer.scrollHeight || 36)}px`;
  }
  clearReplyQuote();
  syncThinkingBar();
  renderSidebar();
  renderHeaderAndInspector();
  renderTranscript();
}

function setReplyQuote(entryId, senderLabel, textSnippet) {
  state.activeReplyTo = {
    id: entryId,
    senderLabel: senderLabel || 'Message',
    snippet: String(textSnippet || '').replace(/\s+/g, ' ').slice(0, 140)
  };
  const banner = document.getElementById('replyQuoteBanner');
  const textEl = document.getElementById('replyQuoteText');
  if (banner && textEl) {
    banner.style.display = 'flex';
    textEl.innerHTML = `<strong>↩ Replying to ${escapeHtml(state.activeReplyTo.senderLabel)}:</strong> ${escapeHtml(state.activeReplyTo.snippet)}`;
  }
  document.getElementById('composerInput')?.focus();
}

function clearReplyQuote() {
  state.activeReplyTo = null;
  const banner = document.getElementById('replyQuoteBanner');
  if (banner) banner.style.display = 'none';
}

function renderHeaderAndInspector() {
  const seat = getSeatById(state.activeSeatId);
  if (!seat) return;

  const av = getSeatResolvedAvatar(seat);
  const activeStatus = state.botStatusBySeat[seat.id] || 'idle';

  // Header live 3D/SVG avatar
  const headerSlot = document.getElementById('activeAvatarSlot');
  const headerCtrl = mountAnimatedAvatar('header-mark', headerSlot, {
    id: seat.id,
    shape: av.shape,
    colorId: av.color,
    sizePx: 36,
    animState: activeStatus,
    followPointer: true
  });
  headerSlot.onclick = (e) => {
    e.stopPropagation();
    headerCtrl?.poke('spin');
  };

  const shortModel = (seat.model || 'gemini-4-argon-low')
    .replace('gemini-4-argon-', 'Argon (')
    .replace('gemini-3.8-flash-', '3.8 (')
    .replace('claude-sonnet-5-5-', 'Sonnet 5.5 (')
    .replace('claude-opus-5-5-', 'Opus 5.5 (')
    .replace(/^(.*)\((low|medium|high)$/, (_, p, e) => `${p}(${e.charAt(0).toUpperCase() + e.slice(1)})`);

  const baseRole = seat.isPrimary ? 'Primary Bot' : (seat.title || (seat.isGroup ? 'Group' : 'Bot'));
  document.getElementById('activeSeatName').textContent = seat.name;
  document.getElementById('activeSeatTitle').textContent = seat.isGroup ? baseRole : `${baseRole} · ${shortModel}`;
  document.getElementById('activeSeatDesc').textContent = seat.description || '';

  const composer = document.getElementById('composerInput');
  composer.placeholder = `Message ${seat.name}…`;

  // Group Room Members Bar
  const groupBar = document.getElementById('groupMembersBar');
  if (seat.isGroup && Array.isArray(seat.memberIds) && seat.memberIds.length > 0) {
    groupBar.style.display = 'flex';
    groupBar.innerHTML = '<span>Bots in Group:</span>';
    seat.memberIds.forEach((mid) => {
      const mSeat = getSeatById(mid);
      if (!mSeat) return;
      const mAv = getSeatResolvedAvatar(mSeat);
      const pill = document.createElement('span');
      pill.className = 'member-pill';
      pill.innerHTML = `<span class="grok-mark-slot sm" style="width:16px;height:16px;min-width:16px;">${getStaticBotSvg(mAv.shape, mAv.color, 16, mSeat.id)}</span><span>${escapeHtml(mSeat.name)}</span>`;
      pill.addEventListener('click', () => selectSeat(mSeat.id));
      groupBar.appendChild(pill);
    });
  } else {
    groupBar.style.display = 'none';
  }

  // Inspector Large Live 3D/SVG Avatar
  const inspSlot = document.getElementById('inspectorAvatarSlot');
  const inspCtrl = mountAnimatedAvatar('inspector-mark', inspSlot, {
    id: seat.id,
    shape: av.shape,
    colorId: av.color,
    sizePx: 68,
    animState: activeStatus,
    followPointer: true
  });
  inspSlot.onclick = () => inspCtrl?.poke('spin');

  // Inspector Form Fields
  document.getElementById('editBotName').value = seat.name || '';
  document.getElementById('editBotTitle').value = seat.title || '';
  const modelSel = document.getElementById('editBotModel');
  if (modelSel) {
    modelSel.value = seat.model || 'gemini-4-argon-low';
  }
  document.getElementById('editBotDesc').value = seat.description || '';
  document.getElementById('editBotPrompt').value = seat.systemPrompt || '';

  const pinBtn = document.getElementById('btnTogglePin');
  pinBtn.textContent = (seat.isPinned || seat.isPrimary) ? 'Unpin from Top' : 'Pin to Top';
  document.getElementById('btnDeleteBot').style.display = seat.isPrimary ? 'none' : 'block';

  // Group member editor inside inspector
  const groupSection = document.getElementById('groupMembersEditorSection');
  const groupChecklist = document.getElementById('groupMembersChecklist');
  if (seat.isGroup) {
    groupSection.style.display = 'block';
    groupChecklist.innerHTML = '';
    state.roster.filter((r) => !r.isGroup).forEach((bot) => {
      const checked = (seat.memberIds || []).includes(bot.id);
      const lbl = document.createElement('label');
      lbl.className = 'checkbox-row';
      lbl.style.marginTop = '2px';
      lbl.innerHTML = `<input type="checkbox" value="${escapeHtml(bot.id)}" ${checked ? 'checked' : ''} /> <span>${escapeHtml(bot.name)}</span>`;
      lbl.querySelector('input').addEventListener('change', async () => {
        const selected = Array.from(groupChecklist.querySelectorAll('input:checked')).map((i) => i.value);
        await window.gravbot.updateBot({ id: seat.id, patch: { memberIds: selected } });
      });
      groupChecklist.appendChild(lbl);
    });
  } else {
    groupSection.style.display = 'none';
  }

  renderAvatarPicker(
    document.getElementById('shapeGrid'),
    document.getElementById('colorGrid'),
    av.shape,
    av.color,
    async (newShape, newColor) => {
      await window.gravbot.updateBot({
        id: seat.id,
        patch: { avatarShape: newShape, avatarColor: newColor }
      });
    }
  );

  renderTokenCostUi();
}

function formatTokenCount(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

function renderTokenCostUi() {
  const seat = getSeatById(state.activeSeatId);
  const pill = document.getElementById('tokenCostPill');
  const summaryEl = document.getElementById('studioTokenSummaryBanner');
  const listEl = document.getElementById('tokenCostBreakdownList');

  let studioTotalTok = 0;
  let studioTotalCost = 0;
  let studioTotalTurns = 0;

  for (const r of state.roster) {
    const u = r.usage || { turns: 0, totalTokens: 0, costUsd: 0 };
    studioTotalTok += u.totalTokens || 0;
    studioTotalCost += u.costUsd || 0;
    studioTotalTurns += u.turns || 0;
  }

  if (pill && seat) {
    const u = seat.usage || { turns: 0, totalTokens: 0, costUsd: 0 };
    pill.textContent = `Est. ${seat.name}: ${formatTokenCount(u.totalTokens)} tok ($${(u.costUsd || 0).toFixed(3)}) · Total: ${formatTokenCount(studioTotalTok)} ($${studioTotalCost.toFixed(2)})`;
  }

  if (summaryEl) {
    summaryEl.innerHTML = `
      <div><strong>Total Tokens:</strong> ${studioTotalTok.toLocaleString()} (${studioTotalTurns} turns)</div>
      <div><strong>Est. Studio Cost:</strong> <span style="color:#00C972;font-weight:600;">$${studioTotalCost.toFixed(4)}</span></div>
    `;
  }

  if (listEl) {
    listEl.innerHTML = '';
    const sorted = [...state.roster].sort(
      (a, b) => ((b.usage && b.usage.totalTokens) || 0) - ((a.usage && a.usage.totalTokens) || 0)
    );
    sorted.forEach((r) => {
      const u = r.usage || { turns: 0, totalTokens: 0, costUsd: 0 };
      const row = document.createElement('div');
      row.className = 'token-ledger-row';
      row.innerHTML = `
        <span class="tl-name">${escapeHtml(r.name)}</span>
        <span class="tl-meta">${formatTokenCount(u.totalTokens)} tok · <strong>$${(u.costUsd || 0).toFixed(4)}</strong></span>
      `;
      row.addEventListener('click', () => selectSeat(r.id));
      listEl.appendChild(row);
    });
  }
}

function renderAvatarPicker(shapeGridEl, colorGridEl, currentShape, currentColor, onSelect) {
  if (!shapeGridEl || !colorGridEl) return;
  shapeGridEl.innerHTML = '';
  colorGridEl.innerHTML = '';

  BOT_SHAPES.forEach((sh) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = `shape-cell ${sh === currentShape ? 'selected' : ''}`;
    cell.title = sh;
    cell.innerHTML = getStaticBotSvg(sh, currentColor, 26, `pick-${sh}`);
    cell.addEventListener('click', () => onSelect(sh, currentColor));
    shapeGridEl.appendChild(cell);
  });

  COLOR_SWATCHES.forEach((sw) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `color-Swatch ${sw.id === currentColor ? 'selected' : ''}`;
    btn.style.background = sw.hex;
    btn.title = sw.label;
    btn.addEventListener('click', () => onSelect(currentShape, sw.id));
    colorGridEl.appendChild(btn);
  });
}

const CONTEXTUAL_VISUAL_RULES = [];

function inferVisualsFromText(text, existingImages = []) {
  const results = [...existingImages];
  const seen = new Set(results.map((im) => im.relPath || im.url));
  const raw = String(text || '');
  if (!raw) return results;

  for (const rule of CONTEXTUAL_VISUAL_RULES) {
    if (rule.test.test(raw)) {
      for (const a of rule.assets) {
        if (!seen.has(a.relPath) && results.length < 4) {
          seen.add(a.relPath);
          results.push({
            relPath: a.relPath,
            url: `http://127.0.0.1:61558/workspace/${encodeURI(a.relPath)}`,
            alt: a.alt,
            width: a.width,
            height: a.height
          });
        }
      }
    }
  }
  return results;
}

function extractEntryDisplay(e, seat) {
  const ts = formatTimestamp(e.timestampMs);
  const senderId = e.senderAgentId || e.authorAgentId || e.agentId || (e.fromAgent && e.fromAgent.id) || '';
  const senderSeat = getSeatById(senderId) || seat;
  const senderName = e.senderName || (e.fromAgent && e.fromAgent.name) || (senderSeat && senderSeat.name) || seat.name;
  const baseMeta = {
    entryId: e.id || '',
    reactions: Array.isArray(e.reactions) ? e.reactions : [],
    replyTo: e.replyTo || (e.message && e.message.reply_to) || null,
    replyQuote: e.replyQuote || null
  };

  if (e.toAgent && e.content) {
    return {
      ...baseMeta,
      isUser: false,
      senderSeat,
      senderLabel: `${seat.name} → ${e.toAgent.name}`,
      routeBadge: 'Handoff',
      ts,
      text: e.content,
      images: inferVisualsFromText(e.content, []),
      widget: null
    };
  }

  if (e.fromAgent && e.content) {
    const fromSeat = getSeatById(e.fromAgent.id) || seat;
    return {
      ...baseMeta,
      isUser: false,
      senderSeat: fromSeat,
      senderLabel: `${e.fromAgent.name} → ${seat.name}`,
      routeBadge: 'From Bot',
      ts,
      text: e.content,
      images: inferVisualsFromText(e.content, []),
      widget: null
    };
  }

  if (e.kind === 'user-attachment') {
    const imgs = [];
    if (e.localRelPath) {
      imgs.push({
        relPath: e.localRelPath,
        url: `http://127.0.0.1:61558/workspace/${encodeURI(e.localRelPath)}`,
        alt: e.file_name || 'Attached image',
        width: e.width,
        height: e.height
      });
    }
    return {
      ...baseMeta,
      isUser: true,
      senderSeat: seat,
      senderLabel: 'You',
      routeBadge: '',
      ts,
      text: `📎 ${e.file_name || e.file_path || 'Attachment'}`,
      images: imgs,
      widget: null
    };
  }

  if (e.kind === 'message') {
    const isUser = e.role === 'user';
    const attList = Array.isArray(e.attachments) ? e.attachments : [];
    const attImgs = [];
    for (const att of attList) {
      if (Array.isArray(att.images)) {
        for (const im of att.images) {
          if (im && im.url && !attImgs.some((x) => x.url === im.url)) {
            attImgs.push(im);
          }
        }
      }
    }
    const textVal = e.content || '';
    return {
      ...baseMeta,
      isUser,
      senderSeat,
      senderLabel: isUser ? 'You' : senderName,
      routeBadge: e.automationId ? 'Routine' : '',
      ts,
      text: textVal,
      attachments: attList,
      images: isUser ? attImgs : inferVisualsFromText(textVal, attImgs),
      widget: null
    };
  }

  if (e.kind === 'send-message' && e.message) {
    const m = e.message;
    const msgImages = (Array.isArray(m.images) ? m.images : []).map((im) => {
      const rel = im.localRelPath || '';
      const webUrl = rel
        ? `http://127.0.0.1:61558/workspace/${encodeURI(rel)}`
        : (im.url || '');
      return {
        relPath: rel,
        url: webUrl,
        alt: im.alt || 'Design asset',
        width: im.width,
        height: im.height
      };
    }).filter((im) => im.url);

    if (m.type === 'widget' && m.widget) {
      return {
        ...baseMeta,
        isUser: false,
        senderSeat,
        senderLabel: senderName,
        routeBadge: '',
        ts,
        text: '',
        images: msgImages,
        widget: m.widget,
        respondedValue: e.respondedValue
      };
    }
    if (m.type === 'secret-request') {
      return {
        ...baseMeta,
        isUser: false,
        senderSeat,
        senderLabel: senderName,
        routeBadge: 'Secret',
        ts,
        text: `🔐 ${m.label || m.secretName || 'Secret'}\n${m.instructions || ''}`,
        images: msgImages,
        widget: null
      };
    }
    if (m.type === 'attachment') {
      if (m.localRelPath) {
        msgImages.push({
          relPath: m.localRelPath,
          url: `http://127.0.0.1:61558/workspace/${encodeURI(m.localRelPath)}`,
          alt: m.file_name || 'Attachment'
        });
      }
      return {
        ...baseMeta,
        isUser: false,
        senderSeat,
        senderLabel: senderName,
        routeBadge: 'File',
        ts,
        text: `📦 ${m.file_name || 'Attachment'}${m.localRelPath ? ` (${m.localRelPath})` : ''}`,
        images: msgImages,
        widget: null
      };
    }
    const textContent = m.content || '';
    return {
      ...baseMeta,
      isUser: false,
      senderSeat,
      senderLabel: senderName,
      routeBadge: '',
      ts,
      text: textContent,
      images: inferVisualsFromText(textContent, msgImages),
      widget: null
    };
  }

  const fallbackText = e.content || '';
  return {
    ...baseMeta,
    isUser: false,
    senderSeat,
    senderLabel: senderName,
    routeBadge: '',
    ts,
    text: fallbackText,
    attachments: Array.isArray(e.attachments) ? e.attachments : [],
    images: inferVisualsFromText(fallbackText, []),
    widget: null
  };
}

function cycleStatusTag(tag) {
  if (!tag) return 'working';
  if (tag === 'working') return 'not-working';
  return '';
}

function getStatusTagLabel(tag) {
  if (tag === 'working') return '✓ Working';
  if (tag === 'not-working') return '✕ Not Working';
  return 'Tag: Working / Issue';
}

function renderComposerAttachments() {
  const bar = document.getElementById('composerAttachmentsBar');
  if (!bar) return;
  if (!state.pendingAttachments || state.pendingAttachments.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = '';

  state.pendingAttachments.forEach((att, idx) => {
    const chip = document.createElement('div');
    const tagClass = att.statusTag === 'working' ? 'working' : (att.statusTag === 'not-working' ? 'not-working' : '');
    chip.className = `composer-att-chip ${tagClass}`;
    const icon = att.isDirectory ? '📁' : '📄';
    const metaLabel = att.isDirectory
      ? `${att.fileCount || 0} file${att.fileCount === 1 ? '' : 's'}`
      : `${Math.max(1, Math.round((att.size || 0) / 1024))} KB`;

    chip.innerHTML = `
      <span>${icon}</span>
      <span class="att-chip-name" title="Click to inspect ${escapeHtml(att.absPath || att.relPath)}">${escapeHtml(att.name)}</span>
      <span class="att-chip-meta">(${escapeHtml(metaLabel)})</span>
      <button type="button" class="att-status-pill ${tagClass}" title="Click to toggle Working / Not Working tag">${escapeHtml(getStatusTagLabel(att.statusTag))}</button>
      <button type="button" class="att-remove-btn" title="Remove attachment">✕</button>
    `;

    chip.querySelector('.att-chip-name')?.addEventListener('click', () => {
      document.getElementById('inspectorPane')?.classList.remove('collapsed');
      document.querySelectorAll('.insp-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.insp-content').forEach((c) => c.classList.remove('active'));
      document.querySelector('.insp-tab[data-tab="workspace"]')?.classList.add('active');
      document.getElementById('tab-workspace')?.classList.add('active');
      const targetRel = (att.htmlFiles && att.htmlFiles[0] && att.htmlFiles[0].relPath) ||
        (att.files && att.files[0] && att.files[0].relPath) ||
        att.relPath;
      if (targetRel) previewWorkspaceFileInline(targetRel);
    });

    chip.querySelector('.att-status-pill')?.addEventListener('click', async () => {
      const nextTag = cycleStatusTag(att.statusTag);
      att.statusTag = nextTag;
      renderComposerAttachments();
      const res = await window.gravbot.setDroppedItemTag({
        id: att.id,
        relPath: att.relPath,
        statusTag: nextTag
      });
      if (res && res.ok) {
        state.droppedItems = res.droppedItems || state.droppedItems;
        state.workspaceFiles = res.workspaceFiles || state.workspaceFiles;
        renderWorkspaceFiles();
      }
    });

    chip.querySelector('.att-remove-btn')?.addEventListener('click', () => {
      state.pendingAttachments.splice(idx, 1);
      renderComposerAttachments();
    });

    bar.appendChild(chip);
  });
}

function renderChatVisualStrip(seat, entries) {
  const stripEl = document.getElementById('chatVisualStrip');
  const thumbsEl = document.getElementById('chatVisualStripThumbs');
  const titleEl = document.getElementById('chatVisualStripTitle');
  if (!stripEl || !thumbsEl) return;

  const collected = [];
  const seen = new Set();
  entries.forEach((e, idx) => {
    const d = extractEntryDisplay(e, seat);
    for (const im of d.images || []) {
      const key = im.relPath || im.url;
      if (key && !seen.has(key)) {
        seen.add(key);
        collected.push({ ...im, msgIdx: idx, entryId: e.id });
      }
    }
  });

  if (collected.length === 0) {
    stripEl.style.display = 'none';
    thumbsEl.innerHTML = '';
    return;
  }

  stripEl.style.display = 'flex';
  if (titleEl) {
    titleEl.textContent = `🖼 ${collected.length} Visual Asset${collected.length === 1 ? '' : 's'} in ${seat.name}`;
  }
  thumbsEl.innerHTML = '';

  collected.slice().reverse().forEach((im) => {
    const card = document.createElement('div');
    card.className = 'strip-thumb-card';
    card.title = `${im.alt || im.relPath} (Click to inspect in Computer Takeover, Alt+Click to jump to message)`;
    card.innerHTML = `
      <img class="strip-thumb-img" src="${escapeHtml(im.url)}" alt="${escapeHtml(im.alt || '')}" loading="lazy" />
      <div class="strip-thumb-label">${escapeHtml(im.alt || (im.relPath || '').split('/').pop() || 'Visual')}</div>
    `;
    card.querySelector('img')?.addEventListener('error', () => card.remove());
    card.addEventListener('click', (ev) => {
      if (ev.altKey && im.entryId) {
        const targetRow = document.querySelector(`.msg-row[data-entry-id="${CSS.escape(im.entryId)}"]`);
        if (targetRow) {
          targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
      }
      openComputerTakeoverModal(im.relPath || im.url, im.alt);
    });
    thumbsEl.appendChild(card);
  });
}

function renderTranscript(forceScrollBottom = false) {
  const stream = document.getElementById('transcriptStream');
  stream.innerHTML = '';

  const seat = getSeatById(state.activeSeatId);
  if (!seat) return;

  const entries = state.transcripts[seat.id] || [];
  const search = state.threadSearch.trim().toLowerCase();

  renderChatVisualStrip(seat, entries);

  if (entries.length === 0) {
    const av = getSeatResolvedAvatar(seat);
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-thread-hero';
    emptyEl.innerHTML = `
      <div class="grok-mark-slot xl" id="emptyHeroMark"></div>
      <h2>${escapeHtml(seat.name)}</h2>
      <p>${escapeHtml(seat.description || 'Send a message below to start working with this Bot on Antigravity.')}</p>
      <p style="font-size:12px; color:var(--text-tertiary); margin-top:4px;">💡 Tip: Drag &amp; drop folders or files here anytime to show Working vs. Not Working examples.</p>
    `;
    stream.appendChild(emptyEl);
    const heroSlot = emptyEl.querySelector('#emptyHeroMark');
    const ctrl = mountAnimatedAvatar('empty-hero-mark', heroSlot, {
      id: seat.id,
      shape: av.shape,
      colorId: av.color,
      sizePx: 68,
      animState: 'idle',
      followPointer: true
    });
    heroSlot.onclick = () => ctrl?.poke('spin');
    return;
  }

  const entryById = new Map();
  entries.forEach((e) => {
    if (e.id) entryById.set(e.id, e);
  });

  entries.forEach((e, idx) => {
    const d = extractEntryDisplay(e, seat);
    const hasAtts = Array.isArray(d.attachments) && d.attachments.length > 0;
    if (!d.text && !d.widget && !hasAtts && (!d.images || d.images.length === 0)) return;

    const searchable = `${d.senderLabel} ${d.text} ${d.widget ? JSON.stringify(d.widget) : ''} ${(d.images || []).map((i) => i.alt).join(' ')} ${(d.attachments || []).map((a) => `${a.name} ${a.statusTag}`).join(' ')}`.toLowerCase();
    if (search && !searchable.includes(search)) return;

    const row = document.createElement('div');
    row.className = `msg-row ${d.isUser ? 'user-row' : 'bot-row'}`;
    if (d.entryId) row.dataset.entryId = d.entryId;

    // Hover Quick Reactions + Reply + Copy Toolbar (Grok Bot parity)
    const toolbar = document.createElement('div');
    toolbar.className = 'msg-hover-toolbar';
    const quickEmojis = ['❤️', '👍', '😂', '🎉', '🔥'];
    quickEmojis.forEach((em) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msg-action-btn';
      b.title = `React ${em}`;
      b.textContent = em;
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!d.entryId) return;
        const res = await window.gravbot.toggleReaction({
          agentId: seat.id,
          entryId: d.entryId,
          emoji: em
        });
        if (res && res.ok) {
          e.reactions = res.reactions;
          renderTranscript(false);
        }
      });
      toolbar.appendChild(b);
    });

    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'msg-action-btn';
    replyBtn.title = 'Reply to message';
    replyBtn.textContent = '↩';
    replyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setReplyQuote(d.entryId, d.senderLabel, d.text);
    });
    toolbar.appendChild(replyBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-action-btn';
    copyBtn.title = 'Copy message text';
    copyBtn.textContent = '📋';
    copyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      navigator.clipboard?.writeText(d.text || '');
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '📋'; }, 1200);
    });
    toolbar.appendChild(copyBtn);
    row.appendChild(toolbar);

    const buildReplyQuoteEl = () => {
      if (!d.replyTo && !d.replyQuote) return null;
      let quoteText = d.replyQuote || '';
      let quoteSender = '';
      if (d.replyTo && entryById.has(d.replyTo)) {
        const refEntry = entryById.get(d.replyTo);
        const refDisp = extractEntryDisplay(refEntry, seat);
        quoteSender = refDisp.senderLabel;
        quoteText = quoteText || String(refDisp.text || '').replace(/\s+/g, ' ').slice(0, 120);
      }
      if (!quoteText && !d.replyTo) return null;
      const qEl = document.createElement('div');
      qEl.className = 'msg-reply-quote';
      qEl.innerHTML = `<strong>↩ ${escapeHtml(quoteSender || 'Replied')}:</strong> ${escapeHtml(quoteText || d.replyTo)}`;
      if (d.replyTo) {
        qEl.addEventListener('click', () => {
          const targetRow = document.querySelector(`.msg-row[data-entry-id="${CSS.escape(d.replyTo)}"]`);
          if (targetRow) targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
      return qEl;
    };

    const buildReactionsRow = () => {
      const reactions = Array.isArray(d.reactions) ? d.reactions : [];
      if (reactions.length === 0) return null;
      const grouped = new Map();
      reactions.forEach((r) => {
        if (!r || !r.emoji) return;
        if (!grouped.has(r.emoji)) {
          grouped.set(r.emoji, { count: 0, mine: false, byNames: [] });
        }
        const g = grouped.get(r.emoji);
        g.count += 1;
        if (r.by === 'me' || r.by === 'user') {
          g.mine = true;
          g.byNames.push('You');
        } else {
          const rSeat = getSeatById(r.by);
          g.byNames.push(rSeat ? rSeat.name : 'Bot');
        }
      });
      if (grouped.size === 0) return null;
      const rRow = document.createElement('div');
      rRow.className = 'msg-reactions-row';
      for (const [emoji, info] of grouped.entries()) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = `msg-reaction-pill ${info.mine ? 'mine' : ''}`;
        pill.title = `Reacted by ${info.byNames.join(', ')}`;
        pill.innerHTML = `<span>${escapeHtml(emoji)}</span><span>${info.count}</span>`;
        pill.addEventListener('click', async () => {
          if (!d.entryId) return;
          const res = await window.gravbot.toggleReaction({
            agentId: seat.id,
            entryId: d.entryId,
            emoji
          });
          if (res && res.ok) {
            e.reactions = res.reactions;
            renderTranscript(false);
          }
        });
        rRow.appendChild(pill);
      }
      return rRow;
    };

    const buildAttachmentsStack = (attachments) => {
      if (!attachments || !attachments.length) return null;
      const stack = document.createElement('div');
      stack.className = 'msg-attachments-stack';
      attachments.forEach((att) => {
        const card = document.createElement('div');
        const tagClass = att.statusTag === 'working' ? 'working' : (att.statusTag === 'not-working' ? 'not-working' : '');
        card.className = `msg-folder-card ${tagClass}`;
        const icon = att.isDirectory ? '📁' : '📄';
        const countBadge = att.isDirectory
          ? `${att.fileCount || (att.files ? att.files.length : 0)} files`
          : `${Math.max(1, Math.round((att.size || 0) / 1024))} KB`;
        const tagBadgeHtml = att.statusTag === 'working'
          ? `<span class="status-tag-badge working">✓ Working</span>`
          : att.statusTag === 'not-working'
            ? `<span class="status-tag-badge not-working">✕ Not Working</span>`
            : '';

        card.innerHTML = `
          <div class="msg-folder-header">
            <div class="msg-folder-title-wrap">
              <span>${icon}</span>
              <span>${escapeHtml(att.name)}</span>
              <span class="msg-visual-dim">${escapeHtml(countBadge)}</span>
              ${tagBadgeHtml}
            </div>
            <div style="display:flex; gap:5px;">
              <button type="button" class="secondary-btn sm-btn btn-inspect-att">Inspect</button>
              <button type="button" class="secondary-btn sm-btn btn-finder-att">Finder</button>
            </div>
          </div>
          <div style="font-size:11px; color:var(--text-tertiary); font-family:var(--font-mono); word-break:break-all;">
            ${escapeHtml(att.absPath || att.relPath)}
          </div>
        `;

        card.querySelector('.btn-inspect-att')?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const firstTarget = (att.htmlFiles && att.htmlFiles[0] && att.htmlFiles[0].relPath) ||
            (att.images && att.images[0] && att.images[0].relPath) ||
            (att.files && att.files[0] && att.files[0].relPath) ||
            att.relPath;
          openComputerTakeoverModal(firstTarget, att.name);
        });

        card.querySelector('.btn-finder-att')?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          window.gravbot.revealWorkspaceFile({ relPath: att.absPath || att.relPath, mode: 'finder' });
        });

        if (att.isDirectory && Array.isArray(att.files) && att.files.length > 0) {
          const filesBox = document.createElement('div');
          filesBox.className = 'msg-folder-files';
          att.files.slice(0, 25).forEach((f) => {
            const fRow = document.createElement('div');
            fRow.className = 'msg-folder-file-row';
            fRow.innerHTML = `
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(f.subPath || f.name)}</span>
              <span style="color:var(--text-tertiary); flex-shrink:0;">${Math.max(1, Math.round((f.size || 0) / 1024))} KB</span>
            `;
            fRow.addEventListener('click', () => {
              if (f.isHtml || f.isImage) {
                openComputerTakeoverModal(f.relPath, `${att.name}/${f.subPath || f.name}`);
              } else {
                document.getElementById('inspectorPane')?.classList.remove('collapsed');
                document.querySelectorAll('.insp-tab').forEach((t) => t.classList.remove('active'));
                document.querySelectorAll('.insp-content').forEach((c) => c.classList.remove('active'));
                document.querySelector('.insp-tab[data-tab="workspace"]')?.classList.add('active');
                document.getElementById('tab-workspace')?.classList.add('active');
                previewWorkspaceFileInline(f.relPath);
              }
            });
            filesBox.appendChild(fRow);
          });
          card.appendChild(filesBox);
        }

        stack.appendChild(card);
      });
      return stack;
    };

    const buildVisualGrid = (images) => {
      if (!images || !images.length) return null;
      const grid = document.createElement('div');
      grid.className = 'msg-visual-grid';
      images.forEach((im) => {
        const card = document.createElement('div');
        card.className = 'msg-visual-card';
        const dimBadge = im.width && im.height ? `<span class="msg-visual-dim">${im.width}×${im.height}</span>` : `<span class="msg-visual-dim">Inspect</span>`;
        card.innerHTML = `
          <img class="msg-visual-img" src="${escapeHtml(im.url)}" alt="${escapeHtml(im.alt || '')}" loading="lazy" />
          <div class="msg-visual-meta">
            <span>${escapeHtml(im.alt || im.relPath || 'Visual Asset')}</span>
            ${dimBadge}
          </div>
        `;
        card.querySelector('img')?.addEventListener('error', () => card.remove());
        card.addEventListener('click', () => {
          openComputerTakeoverModal(im.relPath || im.url, im.alt);
        });
        grid.appendChild(card);
      });
      return grid;
    };

    if (d.isUser) {
      const bubble = document.createElement('div');
      bubble.className = 'user-bubble';
      const qEl = buildReplyQuoteEl();
      if (qEl) bubble.appendChild(qEl);
      const bodyDiv = document.createElement('div');
      bodyDiv.innerHTML = formatMessageHtml(d.text);
      bubble.appendChild(bodyDiv);
      const attStack = buildAttachmentsStack(d.attachments);
      if (attStack) bubble.appendChild(attStack);
      const vGrid = buildVisualGrid(d.images);
      if (vGrid) bubble.appendChild(vGrid);
      const rRow = buildReactionsRow();
      if (rRow) bubble.appendChild(rRow);
      row.appendChild(bubble);
    } else {
      const av = getSeatResolvedAvatar(d.senderSeat);
      const wrap = document.createElement('div');
      wrap.className = 'bot-msg-wrap';
      wrap.innerHTML = `
        <div class="grok-mark-slot sm" style="margin-top: 2px;">
          ${getStaticBotSvg(av.shape, av.color, 24, `msg-${idx}`)}
        </div>
        <div class="bot-msg-content">
          <div class="bot-msg-header">
            <span class="bot-msg-sender">${escapeHtml(d.senderLabel)}</span>
            ${d.routeBadge ? `<span class="route-badge">${escapeHtml(d.routeBadge)}</span>` : ''}
            <span class="bot-msg-time">${escapeHtml(d.ts)}</span>
          </div>
          ${d.text ? `<div class="bot-msg-body">${formatMessageHtml(d.text)}</div>` : ''}
        </div>
      `;

      const contentEl = wrap.querySelector('.bot-msg-content');
      const qEl = buildReplyQuoteEl();
      if (qEl && contentEl) {
        const headerEl = contentEl.querySelector('.bot-msg-header');
        headerEl?.insertAdjacentElement('afterend', qEl);
      }

      const attStack = buildAttachmentsStack(d.attachments);
      if (attStack && contentEl) {
        contentEl.appendChild(attStack);
      }

      const vGrid = buildVisualGrid(d.images);
      if (vGrid && contentEl) {
        contentEl.appendChild(vGrid);
      }

      if (d.widget && contentEl) {
        const wCard = document.createElement('div');
        wCard.className = 'widget-card';
        const steps = d.widget.steps && d.widget.steps.length ? d.widget.steps : [d.widget];
        steps.forEach((st) => {
          const promptEl = document.createElement('div');
          promptEl.className = 'widget-prompt';
          promptEl.textContent = st.prompt || 'Choose an option';
          wCard.appendChild(promptEl);

          const optsWrap = document.createElement('div');
          optsWrap.className = 'widget-options';
          (st.options || []).forEach((opt) => {
            const btn = document.createElement('button');
            btn.className = `widget-btn ${opt.style === 'primary' ? 'primary' : ''}`;
            btn.textContent = opt.label;
            btn.addEventListener('click', () => {
              window.gravbot.respondWidget({
                agentId: seat.id,
                entryId: d.entryId,
                value: opt.value,
                label: opt.label
              });
            });
            optsWrap.appendChild(btn);
          });
          wCard.appendChild(optsWrap);
        });
        if (d.respondedValue) {
          const resp = document.createElement('div');
          resp.className = 'widget-responded';
          resp.textContent = `✓ Selected: ${d.respondedValue}`;
          wCard.appendChild(resp);
        }
        contentEl.appendChild(wCard);
      }

      const rRow = buildReactionsRow();
      if (rRow && contentEl) {
        contentEl.appendChild(rRow);
      }

      row.appendChild(wrap);
    }

    stream.appendChild(row);
  });

  const savedScroll = state.scrollTopBySeat[seat.id];
  if (!forceScrollBottom && typeof savedScroll === 'number') {
    stream.scrollTop = savedScroll;
  } else {
    stream.scrollTop = stream.scrollHeight;
  }
}

let activeComputerFilter = 'visual';
let activePreviewRelPath = '';

const COMPUTER_QUICK_LAUNCH = [];

function matchesComputerFilter(f, filter) {
  const p = (f.path || '').toLowerCase();
  const ext = (f.ext || '').toLowerCase();
  if (filter === 'all') return true;
  if (filter === 'dropped') return p.startsWith('@dropped/');
  if (filter === 'working') return f.statusTag === 'working';
  if (filter === 'not-working') return f.statusTag === 'not-working';
  if (filter === 'html') return ext === '.html';
  if (filter === 'fleek') return p.includes('fleek');
  if (filter === 'docs') return ext === '.md' || ext === '.css' || ext === '.json';
  if (filter === 'visual') {
    if (p.startsWith('design-assets/grav-cache/')) return false;
    return ['.html', '.png', '.svg', '.webp', '.jpg'].includes(ext);
  }
  return true;
}

async function previewWorkspaceFileInline(relPath) {
  activePreviewRelPath = relPath;
  const res = await window.gravbot.readWorkspaceFile(relPath);
  if (!res.ok) return;
  const sec = document.getElementById('filePreviewSection');
  const nameEl = document.getElementById('previewFileName');
  const visEl = document.getElementById('previewVisualContainer');
  const codeEl = document.getElementById('previewFileContent');
  if (!sec || !nameEl || !visEl || !codeEl) return;

  sec.style.display = 'block';
  nameEl.textContent = res.path;

  if (res.isHtml) {
    visEl.style.display = 'block';
    visEl.innerHTML = `<iframe sandbox="allow-scripts" src="${escapeHtml(res.url)}" style="width:100%; height:260px; border:1px solid var(--border-strong); border-radius:8px; background:#F6F4EE;"></iframe>`;
    codeEl.style.display = 'none';
  } else if (res.isImage) {
    visEl.style.display = 'block';
    visEl.innerHTML = `<img src="${escapeHtml(res.url)}" style="width:100%; max-height:280px; object-fit:contain; border:1px solid var(--border-strong); border-radius:8px; background:#101214; cursor:pointer;" title="Click to expand in Computer Takeover" />`;
    visEl.querySelector('img')?.addEventListener('click', () => openComputerTakeoverModal(res.path));
    codeEl.style.display = res.ext === '.svg' ? 'block' : 'none';
    codeEl.textContent = res.ext === '.svg' ? res.content : '';
  } else {
    visEl.style.display = 'none';
    visEl.innerHTML = '';
    codeEl.style.display = 'block';
    codeEl.textContent = res.content;
  }
}

function openComputerTakeoverModal(relPathOrUrl, titleText = '') {
  const modal = document.getElementById('computerTakeoverModal');
  if (!modal) return;
  modal.style.display = 'flex';

  let relPath = relPathOrUrl || activePreviewRelPath || 'findrequest-ux/ux/wireframes/b1.html';
  if (relPath.startsWith('http://127.0.0.1:61558/workspace/')) {
    relPath = decodeURIComponent(relPath.slice('http://127.0.0.1:61558/workspace/'.length));
  }
  activePreviewRelPath = relPath;

  // Render Quick Launch Bar
  const quickBar = document.getElementById('computerQuickBar');
  if (quickBar) {
    quickBar.innerHTML = '';
    COMPUTER_QUICK_LAUNCH.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = `quick-launch-pill ${item.relPath === relPath ? 'active' : ''}`;
      btn.textContent = item.label;
      btn.addEventListener('click', () => openComputerTakeoverModal(item.relPath, item.label));
      quickBar.appendChild(btn);
    });
  }

  // Render Sidebar of visual & HTML files
  const sideEl = document.getElementById('computerAssetSidebar');
  if (sideEl) {
    sideEl.innerHTML = '';
    const visualFiles = state.workspaceFiles.filter((f) => {
      const ext = (f.ext || '').toLowerCase();
      return !f.path.startsWith('design-assets/grav-cache/') && ['.html', '.png', '.svg', '.webp', '.md', '.jpg'].includes(ext);
    });
    visualFiles.forEach((f) => {
      const item = document.createElement('div');
      item.className = `computer-asset-item ${f.path === relPath ? 'active' : ''}`;
      const badgeClass = f.ext === '.html' ? 'html' : (['.png', '.svg', '.webp', '.jpg'].includes(f.ext) ? 'img' : '');
      item.innerHTML = `
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(f.path)}">
          <span class="file-badge ${badgeClass}">${escapeHtml((f.ext || '').replace('.', '').toUpperCase() || 'FILE')}</span>
          ${escapeHtml(f.path.replace(/^@dropped\//, '📁 ').split('/').slice(-2).join('/'))}
        </span>
      `;
      item.addEventListener('click', () => openComputerTakeoverModal(f.path));
      sideEl.appendChild(item);
    });
  }

  // Render Stage
  const frameEl = document.getElementById('computerViewportFrame');
  const titleEl = document.getElementById('computerActiveTitle');
  if (titleEl) {
    titleEl.textContent = titleText ? `${titleText} (${relPath})` : `Grav Bot's Computer — ${relPath}`;
  }
  if (frameEl) {
    const webUrl = `http://127.0.0.1:61558/workspace/${encodeURI(relPath)}`;
    const lower = relPath.toLowerCase();
    if (lower.endsWith('.html')) {
      frameEl.innerHTML = `<iframe sandbox="allow-scripts" src="${escapeHtml(webUrl)}" title="${escapeHtml(relPath)}"></iframe>`;
    } else if (lower.endsWith('.png') || lower.endsWith('.webp') || lower.endsWith('.svg') || lower.endsWith('.jpg') || lower.endsWith('.gif')) {
      frameEl.innerHTML = `<div style="padding:16px; width:100%; display:flex; justify-content:center; background:#101214;"><img src="${escapeHtml(webUrl)}" alt="${escapeHtml(relPath)}" /></div>`;
    } else {
      window.gravbot.readWorkspaceFile(relPath).then((res) => {
        if (res.ok) {
          frameEl.innerHTML = `<pre class="code-box" style="width:100%; margin:0; max-height:none; height:calc(91vh - 140px); padding:18px;">${escapeHtml(res.content)}</pre>`;
        }
      });
    }
  }
}

function attachDroppedItemToComposer(item) {
  if (!item) return;
  const existingIdx = state.pendingAttachments.findIndex((x) => x.id === item.id || x.relPath === item.relPath);
  if (existingIdx >= 0) {
    state.pendingAttachments[existingIdx] = item;
  } else {
    state.pendingAttachments.push(item);
  }
  renderComposerAttachments();
}

function renderDroppedFoldersSection() {
  const container = document.getElementById('droppedFoldersContainer');
  if (!container) return;
  container.innerHTML = '';
  window.__gravbotDroppedItemsCount = (state.droppedItems || []).length;

  const items = (state.droppedItems || []).filter((item) => {
    if (activeComputerFilter === 'working') return item.statusTag === 'working';
    if (activeComputerFilter === 'not-working') return item.statusTag === 'not-working';
    if (activeComputerFilter === 'fleek') return (item.name || '').toLowerCase().includes('fleek');
    return true;
  });

  if (items.length === 0) return;

  items.forEach((item) => {
    const card = document.createElement('div');
    const tagClass = item.statusTag === 'working' ? 'working' : (item.statusTag === 'not-working' ? 'not-working' : '');
    card.className = `dropped-folder-item ${tagClass}`;
    card.draggable = true;
    card.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('application/x-gravbot-item', JSON.stringify(item));
      ev.dataTransfer.effectAllowed = 'copyMove';
    });

    const isExpanded = Boolean(state.expandedDroppedFolders[item.id]);
    const icon = item.isDirectory ? (isExpanded ? '📂' : '📁') : '📄';
    const tagPillLabel = item.statusTag === 'working'
      ? '✓ Working'
      : item.statusTag === 'not-working'
        ? '✕ Not Working'
        : 'Tag';

    const hdr = document.createElement('div');
    hdr.className = 'dropped-folder-row';
    hdr.innerHTML = `
      <div style="display:flex; align-items:center; gap:6px; min-width:0; flex:1;">
        <span>${icon}</span>
        <span style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(item.absPath || item.relPath)}">${escapeHtml(item.name)}</span>
        <span style="font-size:10.5px; color:var(--text-tertiary); font-family:var(--font-mono);">(${item.isDirectory ? `${item.fileCount || 0}f` : '1f'})</span>
      </div>
      <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
        <button type="button" class="att-status-pill ${tagClass} btn-tag-drop" title="Click to toggle Working / Not Working">${escapeHtml(tagPillLabel)}</button>
        <button type="button" class="secondary-btn sm-btn btn-chat-drop" title="Attach to Chat Composer">+ Chat</button>
        <button type="button" class="att-remove-btn btn-del-drop" title="Remove from Computer">✕</button>
      </div>
    `;

    hdr.addEventListener('click', () => {
      if (item.isDirectory) {
        state.expandedDroppedFolders[item.id] = !state.expandedDroppedFolders[item.id];
        renderDroppedFoldersSection();
      } else {
        previewWorkspaceFileInline(item.relPath);
      }
    });

    hdr.querySelector('.btn-tag-drop')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const nextTag = cycleStatusTag(item.statusTag);
      const res = await window.gravbot.setDroppedItemTag({
        id: item.id,
        relPath: item.relPath,
        statusTag: nextTag
      });
      if (res && res.ok) {
        state.droppedItems = res.droppedItems || [];
        state.workspaceFiles = res.workspaceFiles || state.workspaceFiles;
        const pending = state.pendingAttachments.find((x) => x.id === item.id);
        if (pending) pending.statusTag = nextTag;
        renderComposerAttachments();
        renderWorkspaceFiles();
      }
    });

    hdr.querySelector('.btn-chat-drop')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      attachDroppedItemToComposer(item);
      showStatusToast(`Attached ${item.name} to composer`, 'Ready to send to Bot');
    });

    hdr.querySelector('.btn-del-drop')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const res = await window.gravbot.removeDroppedItem({ id: item.id, relPath: item.relPath });
      if (res && res.ok) {
        state.droppedItems = res.droppedItems || [];
        state.workspaceFiles = res.workspaceFiles || [];
        state.pendingAttachments = state.pendingAttachments.filter((x) => x.id !== item.id);
        renderComposerAttachments();
        renderWorkspaceFiles();
      }
    });

    card.appendChild(hdr);

    if (item.isDirectory && isExpanded && Array.isArray(item.files) && item.files.length > 0) {
      const children = document.createElement('div');
      children.className = 'dropped-folder-children';
      item.files.forEach((f) => {
        const fRow = document.createElement('div');
        fRow.className = 'file-row';
        fRow.innerHTML = `
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(f.subPath || f.name)}</span>
          <span style="color:var(--text-tertiary); white-space:nowrap;">${Math.max(1, Math.round((f.size || 0) / 1024))} KB</span>
        `;
        fRow.addEventListener('click', () => previewWorkspaceFileInline(f.relPath));
        fRow.addEventListener('dblclick', () => openComputerTakeoverModal(f.relPath, `${item.name}/${f.subPath || f.name}`));
        children.appendChild(fRow);
      });
      card.appendChild(children);
    }

    container.appendChild(card);
  });
}

function renderWorkspaceFiles() {
  const pathNote = document.getElementById('workspacePathNote');
  if (pathNote) pathNote.textContent = state.workspaceDir;

  renderDroppedFoldersSection();

  const listEl = document.getElementById('workspaceFileList');
  if (!listEl) return;
  listEl.innerHTML = '';

  const filtered = state.workspaceFiles.filter((f) => matchesComputerFilter(f, activeComputerFilter));

  filtered.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.draggable = true;
    row.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('application/x-gravbot-path', f.path);
      ev.dataTransfer.effectAllowed = 'copy';
    });
    const ext = (f.ext || '').toLowerCase();
    const badgeClass = ext === '.html' ? 'html' : (['.png', '.svg', '.webp', '.jpg'].includes(ext) ? 'img' : '');
    const statusDot = f.statusTag === 'working'
      ? '<span class="status-tag-badge working" style="margin-right:5px;">✓</span>'
      : f.statusTag === 'not-working'
        ? '<span class="status-tag-badge not-working" style="margin-right:5px;">✕</span>'
        : '';
    const displayPath = f.path.replace(/^@dropped\//, '📁 ');
    row.innerHTML = `
      <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
        ${statusDot}<span class="file-badge ${badgeClass}">${escapeHtml(ext.replace('.', '').toUpperCase() || 'FILE')}</span>
        ${escapeHtml(displayPath)}
      </span>
      <span style="color:var(--text-tertiary); white-space:nowrap;">${Math.max(1, Math.round(f.size / 1024))} KB</span>
    `;
    row.addEventListener('click', () => {
      previewWorkspaceFileInline(f.path);
    });
    row.addEventListener('dblclick', () => {
      openComputerTakeoverModal(f.path);
    });
    listEl.appendChild(row);
  });
}

function openCreateModal(mode = 'bot') {
  state.modalMode = mode;
  state.modalShape = mode === 'group' ? 'sparkle' : 'blob';
  state.modalColor = mode === 'group' ? 'violet' : 'blue';

  document.getElementById('createModalTitle').textContent = mode === 'group' ? 'New Group' : 'New Bot';
  document.getElementById('modalBotName').value = '';
  document.getElementById('modalBotTitle').value = '';
  document.getElementById('modalBotPrompt').value = '';

  document.getElementById('modalBotPromptWrap').style.display = mode === 'group' ? 'none' : 'block';
  const groupWrap = document.getElementById('modalGroupMembersWrap');
  const checklist = document.getElementById('modalGroupChecklist');

  if (mode === 'group') {
    groupWrap.style.display = 'block';
    checklist.innerHTML = '';
    state.roster.filter((r) => !r.isGroup).forEach((bot) => {
      const lbl = document.createElement('label');
      lbl.className = 'checkbox-row';
      lbl.style.marginTop = '2px';
      lbl.innerHTML = `<input type="checkbox" value="${escapeHtml(bot.id)}" ${bot.isPrimary ? 'checked' : ''} /> <span>${escapeHtml(bot.name)}</span>`;
      checklist.appendChild(lbl);
    });
  } else {
    groupWrap.style.display = 'none';
  }

  const refreshModalPicker = () => {
    mountAnimatedAvatar('modal-preview-mark', document.getElementById('modalAvatarPreview'), {
      id: 'modal-preview',
      shape: state.modalShape,
      colorId: state.modalColor,
      sizePx: 68,
      animState: 'idle',
      followPointer: true
    });
    renderAvatarPicker(
      document.getElementById('modalShapeGrid'),
      document.getElementById('modalColorGrid'),
      state.modalShape,
      state.modalColor,
      (sh, col) => {
        state.modalShape = sh;
        state.modalColor = col;
        refreshModalPicker();
      }
    );
  };

  refreshModalPicker();
  document.getElementById('createModal').style.display = 'flex';
  document.getElementById('modalBotName').focus();
}

function closeCreateModal() {
  document.getElementById('createModal').style.display = 'none';
}

async function readWebkitEntryRecursively(entry, parentPath = '', out = []) {
  if (!entry || out.length >= 160) return out;
  const relPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isDirectory) {
    out.push({ relPath, isDirectory: true });
    const reader = entry.createReader();
    const readBatch = () => new Promise((resolve) => {
      reader.readEntries((entries) => resolve(entries || []), () => resolve([]));
    });
    let batch = await readBatch();
    while (batch.length > 0 && out.length < 160) {
      for (const child of batch) {
        if (child.name.startsWith('.') || child.name === 'node_modules' || child.name === '__pycache__') continue;
        await readWebkitEntryRecursively(child, relPath, out);
      }
      batch = await readBatch();
    }
  } else if (entry.isFile) {
    const fileObj = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
    if (fileObj && fileObj.size <= 25 * 1024 * 1024) {
      const base64 = await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => {
          const s = String(fr.result || '');
          const comma = s.indexOf(',');
          resolve(comma >= 0 ? s.slice(comma + 1) : '');
        };
        fr.onerror = () => resolve('');
        fr.readAsDataURL(fileObj);
      });
      out.push({ relPath, isDirectory: false, base64 });
    }
  }
  return out;
}

async function handleDropPayload(e, statusTag = '', attachToComposer = true) {
  const dt = e.dataTransfer;
  if (!dt) return;

  // 1. Check if dragged from Grav Bot's Computer
  const internalItemJson = dt.getData('application/x-gravbot-item');
  if (internalItemJson) {
    try {
      const item = JSON.parse(internalItemJson);
      if (statusTag && item.statusTag !== statusTag) {
        item.statusTag = statusTag;
        const res = await window.gravbot.setDroppedItemTag({
          id: item.id,
          relPath: item.relPath,
          statusTag
        });
        if (res && res.ok) {
          state.droppedItems = res.droppedItems || state.droppedItems;
          state.workspaceFiles = res.workspaceFiles || state.workspaceFiles;
          renderWorkspaceFiles();
        }
      }
      if (attachToComposer) {
        attachDroppedItemToComposer(item);
        const tagNote = item.statusTag === 'working' ? ' · ✓ Working' : item.statusTag === 'not-working' ? ' · ✕ Not Working' : '';
        showStatusToast(`Attached ${item.name}${tagNote}`, 'Ready in composer');
      }
      return;
    } catch (err) {}
  }

  const internalPath = dt.getData('application/x-gravbot-path');
  if (internalPath) {
    const res = await window.gravbot.ingestDroppedPaths({ paths: [internalPath], statusTag });
    if (res && res.ok && Array.isArray(res.items)) {
      state.droppedItems = res.droppedItems || state.droppedItems;
      state.workspaceFiles = res.workspaceFiles || state.workspaceFiles;
      renderWorkspaceFiles();
      if (attachToComposer) {
        res.items.forEach((it) => attachDroppedItemToComposer(it));
      }
      showStatusToast(`Attached ${res.items.map((i) => i.name).join(', ')}`, 'Ready in composer');
    }
    return;
  }

  // 2. Extract native Finder paths from dropped files/folders
  const paths = [];
  const fileList = Array.from(dt.files || []);
  for (const f of fileList) {
    const p = window.gravbot.getPathForFile(f);
    if (p && !paths.includes(p)) {
      paths.push(p);
    }
  }

  // 3. Also check text/uri-list for file:// URLs
  if (paths.length === 0) {
    const uriList = dt.getData('text/uri-list') || '';
    uriList.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('file://') && !paths.includes(trimmed)) {
        paths.push(trimmed);
      }
    });
  }

  let res = null;
  if (paths.length > 0) {
    res = await window.gravbot.ingestDroppedPaths({ paths, statusTag });
  } else if (dt.items && dt.items.length > 0) {
    // 4. Fallback: recursively read directory/file entries via webkitGetAsEntry()
    const entries = [];
    const wkEntries = [];
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.webkitGetAsEntry) {
        const ent = item.webkitGetAsEntry();
        if (ent) wkEntries.push(ent);
      }
    }
    for (const ent of wkEntries) {
      await readWebkitEntryRecursively(ent, '', entries);
    }
    if (entries.length > 0) {
      res = await window.gravbot.ingestDroppedEntries({ entries, statusTag });
    }
  }

  if (res && res.ok && Array.isArray(res.items) && res.items.length > 0) {
    state.droppedItems = res.droppedItems || state.droppedItems;
    state.workspaceFiles = res.workspaceFiles || state.workspaceFiles;
    res.items.forEach((it) => {
      if (it.isDirectory) state.expandedDroppedFolders[it.id] = true;
      if (attachToComposer) attachDroppedItemToComposer(it);
    });
    renderWorkspaceFiles();
    const names = res.items.map((i) => `${i.isDirectory ? '📁' : '📄'} ${i.name}`).join(', ');
    const badge = statusTag === 'working'
      ? 'Tagged ✓ Working'
      : statusTag === 'not-working'
        ? 'Tagged ✕ Not Working'
        : 'Added to Composer & Computer';
    showStatusToast(`Dropped ${names}`, badge);
  }
}

async function triggerBrowseFoldersOrFiles(statusTag = '', attachToComposer = true) {
  const res = await window.gravbot.pickFilesOrFolders({ statusTag });
  if (res && res.ok && Array.isArray(res.items) && res.items.length > 0) {
    state.droppedItems = res.droppedItems || state.droppedItems;
    state.workspaceFiles = res.workspaceFiles || state.workspaceFiles;
    res.items.forEach((it) => {
      if (it.isDirectory) state.expandedDroppedFolders[it.id] = true;
      if (attachToComposer) attachDroppedItemToComposer(it);
    });
    renderWorkspaceFiles();
    const names = res.items.map((i) => `${i.isDirectory ? '📁' : '📄'} ${i.name}`).join(', ');
    const badge = statusTag === 'working'
      ? 'Tagged ✓ Working'
      : statusTag === 'not-working'
        ? 'Tagged ✕ Not Working'
        : 'Attached to Composer & Computer';
    showStatusToast(`Attached ${names}`, badge);
  }
}

function setupFolderAndFileDragDrop() {
  const mainEl = document.querySelector('.sand-main');
  const overlay = document.getElementById('globalDropOverlay');
  const buckets = document.querySelectorAll('.drop-target-bucket');
  const wsDropZone = document.getElementById('workspaceDropZone');
  const tabWorkspace = document.getElementById('tab-workspace');

  // Prevent default browser file navigation globally
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
  });

  let dragDepth = 0;

  const isSupportedDrag = (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types) return false;
    const types = Array.from(e.dataTransfer.types);
    return (
      types.includes('Files') ||
      types.includes('text/uri-list') ||
      types.includes('application/x-gravbot-item') ||
      types.includes('application/x-gravbot-path')
    );
  };

  if (mainEl && overlay) {
    mainEl.addEventListener('dragenter', (e) => {
      if (!isSupportedDrag(e)) return;
      e.preventDefault();
      dragDepth++;
      overlay.style.display = 'flex';
    });

    mainEl.addEventListener('dragover', (e) => {
      if (!isSupportedDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      overlay.style.display = 'flex';
    });

    mainEl.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 || !mainEl.contains(e.relatedTarget)) {
        dragDepth = 0;
        overlay.style.display = 'none';
        buckets.forEach((b) => b.classList.remove('drag-hover'));
      }
    });

    mainEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      const hoveredBucket = e.target.closest('.drop-target-bucket');
      const statusTag = hoveredBucket ? (hoveredBucket.dataset.dropTag || '') : '';
      overlay.style.display = 'none';
      buckets.forEach((b) => b.classList.remove('drag-hover'));
      await handleDropPayload(e, statusTag, true);
    });

    buckets.forEach((bucket) => {
      bucket.addEventListener('dragenter', (e) => {
        e.preventDefault();
        buckets.forEach((b) => b.classList.remove('drag-hover'));
        bucket.classList.add('drag-hover');
      });
      bucket.addEventListener('dragover', (e) => {
        e.preventDefault();
        bucket.classList.add('drag-hover');
      });
    });
  }

  // Also allow dropping folders/files directly onto Grav Bot's Computer drawer
  if (tabWorkspace) {
    tabWorkspace.addEventListener('dragover', (e) => {
      if (!isSupportedDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      wsDropZone?.classList.add('drag-hover');
    });
    tabWorkspace.addEventListener('dragleave', (e) => {
      if (!tabWorkspace.contains(e.relatedTarget)) {
        wsDropZone?.classList.remove('drag-hover');
      }
    });
    tabWorkspace.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      wsDropZone?.classList.remove('drag-hover');
      const defaultTag = activeComputerFilter === 'working'
        ? 'working'
        : activeComputerFilter === 'not-working'
          ? 'not-working'
          : '';
      await handleDropPayload(e, defaultTag, true);
    });
  }

  document.getElementById('btnAttachFolder')?.addEventListener('click', () => {
    triggerBrowseFoldersOrFiles('', true);
  });
  document.getElementById('btnAddWorkingFolder')?.addEventListener('click', () => {
    triggerBrowseFoldersOrFiles('working', true);
  });
  document.getElementById('btnAddNotWorkingFolder')?.addEventListener('click', () => {
    triggerBrowseFoldersOrFiles('not-working', true);
  });
  document.getElementById('btnWorkspaceAddFolder')?.addEventListener('click', () => {
    triggerBrowseFoldersOrFiles('', true);
  });
}

async function init() {
  const initial = await window.gravbot.getInitialState();
  state.roster = initial.appState.roster || [];
  state.transcripts = initial.appState.transcripts || {};
  state.primaryBotId = initial.appState.primaryBotId || (state.roster[0] && state.roster[0].id);
  state.settings = initial.appSettings || {};
  state.workspaceDir = initial.workspaceDir || '';
  state.droppedDir = initial.droppedDir || '';
  state.droppedItems = initial.droppedItems || [];
  state.workspaceFiles = initial.workspaceFiles || [];
  const savedSeatId = localStorage.getItem('gravbot_active_seat_id');
  state.activeSeatId = (savedSeatId && state.roster.some((r) => r.id === savedSeatId))
    ? savedSeatId
    : state.primaryBotId;
  try {
    const savedDrafts = JSON.parse(localStorage.getItem('gravbot_drafts_v1') || '{}');
    if (savedDrafts && typeof savedDrafts === 'object') {
      state.draftBySeat = savedDrafts;
    }
  } catch (e) {}

  document.getElementById('settingAgyPath').value = state.settings.agyPath || '';
  document.getElementById('settingEffort').value = state.settings.effort || 'low';
  document.getElementById('settingSkipPermissions').checked = state.settings.skipPermissions !== false;

  const initComposer = document.getElementById('composerInput');
  if (initComposer && state.activeSeatId && state.draftBySeat[state.activeSeatId]) {
    initComposer.value = state.draftBySeat[state.activeSeatId];
  }

  window.selectSeat = selectSeat;
  renderSidebar();
  renderHeaderAndInspector();
  renderTranscript();
  renderWorkspaceFiles();
  renderComposerAttachments();
  setupFolderAndFileDragDrop();

  // Wire clickable file pills (.gb-file-pill) and scroll-to-bottom button in #transcriptStream
  const transcriptEl = document.getElementById('transcriptStream');
  const btnScrollBottom = document.getElementById('btnScrollBottom');
  if (transcriptEl) {
    transcriptEl.addEventListener('click', (e) => {
      const pill = e.target.closest('.gb-file-pill');
      if (!pill) return;
      e.preventDefault();
      const rawPath = pill.dataset.gbFile || pill.dataset.filePath || '';
      if (!rawPath) return;
      const clean = rawPath.replace(/^file:\/\//i, '');
      const baseName = clean.split('/').filter(Boolean).pop() || clean;
      const matchWs = (state.workspaceFiles || []).find(
        (f) => f.relPath === clean || f.relPath.endsWith(`/${baseName}`) || f.name === baseName
      );
      if (matchWs) {
        openComputerTakeoverModal(matchWs.relPath);
      } else {
        openComputerTakeoverModal(baseName);
      }
    });

    transcriptEl.addEventListener('scroll', () => {
      if (state.activeSeatId) {
        state.scrollTopBySeat[state.activeSeatId] = transcriptEl.scrollTop;
      }
      if (btnScrollBottom) {
        const distFromBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
        btnScrollBottom.style.display = distFromBottom > 240 ? ' inline-flex' : 'none';
      }
    });
  }

  btnScrollBottom?.addEventListener('click', () => {
    if (transcriptEl) {
      transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: 'smooth' });
      btnScrollBottom.style.display = 'none';
    }
  });

  // Wire Chat Visual Strip header buttons
  document.getElementById('btnOpenStripTakeover')?.addEventListener('click', () => {
    openComputerTakeoverModal(activePreviewRelPath || 'findrequest-ux/ux/wireframes/b1.html');
  });
  document.getElementById('btnToggleStripCollapse')?.addEventListener('click', () => {
    state.visualStripCollapsed = !state.visualStripCollapsed;
    const strip = document.getElementById('chatVisualStrip');
    const btn = document.getElementById('btnToggleStripCollapse');
    if (strip) strip.classList.toggle('collapsed', state.visualStripCollapsed);
    if (btn) btn.textContent = state.visualStripCollapsed ? 'Expand ▾' : 'Collapse ▴';
  });

  // Wire Cancel Reply Quote button
  document.getElementById('btnCancelReplyQuote')?.addEventListener('click', () => {
    state.activeReplyTo = null;
    const banner = document.getElementById('replyQuoteBanner');
    if (banner) banner.style.display = 'none';
  });

  // Search inputs
  document.getElementById('seatFilterInput').addEventListener('input', (e) => {
    state.seatFilter = e.target.value;
    renderSidebar();
  });

  document.getElementById('threadSearchInput').addEventListener('input', (e) => {
    state.threadSearch = e.target.value;
    renderTranscript();
  });

  const composerInput = document.getElementById('composerInput');

  // Voice state bookkeeping; the public mic action uses macOS Dictation.
  let voiceActive = false;
  let voiceStarting = false;
  let voiceSettling = false;
  let voiceSettlingTimer = null;
  let voiceSessionId = null;
  let voiceSeq = 0;
  let sharedVoiceAudioCtx = null;
  let voiceMediaStream = null;
  let voiceSourceNode = null;
  let voiceProcessor = null;
  let voiceAnimFrame = null;
  let voiceBaseText = '';
  let voiceCommittedText = '';

  const btnMic = document.getElementById('btnMic');
  const recPill = document.getElementById('recordingStatusPill');
  const recLabel = document.getElementById('recordingTimerLabel');
  const defaultMicSvg = btnMic ? btnMic.innerHTML : '';

  const teardownAudioNodes = () => {
    if (voiceAnimFrame) {
      cancelAnimationFrame(voiceAnimFrame);
      voiceAnimFrame = null;
    }
    if (voiceProcessor) {
      try {
        voiceProcessor.onaudioprocess = null;
        voiceProcessor.disconnect();
      } catch (e) {}
      voiceProcessor = null;
    }
    if (voiceSourceNode) {
      try { voiceSourceNode.disconnect(); } catch (e) {}
      voiceSourceNode = null;
    }
    if (voiceMediaStream) {
      try { voiceMediaStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      voiceMediaStream = null;
    }
  };

  const stopVoiceStreaming = async ({ immediate = false } = {}) => {
    if (voiceSettlingTimer) {
      clearTimeout(voiceSettlingTimer);
      voiceSettlingTimer = null;
    }
    const wasActive = voiceActive || voiceStarting || voiceSettling;
    voiceActive = false;
    voiceStarting = false;
    teardownAudioNodes();

    if (btnMic) {
      btnMic.classList.remove('recording');
      btnMic.innerHTML = defaultMicSvg;
    }

    const sid = voiceSessionId;
    if (immediate) {
      voiceSettling = false;
      voiceSessionId = null;
      if (recPill) recPill.style.display = 'none';
      if (sid) {
        await window.gravbot.voiceStreamStop({ sessionId: sid, immediate: true });
      }
      return;
    }

    if (!wasActive) return;

    // Antigravity Fje settling window: allow trailing words to arrive from EndAudioSession
    if (sid) {
      voiceSettling = true;
      if (recPill && recLabel) {
        recLabel.textContent = 'Finishing words…';
      }
      voiceSettlingTimer = setTimeout(() => {
        voiceSettling = false;
        voiceSessionId = null;
        if (recPill) recPill.style.display = 'none';
      }, 1200);
      await window.gravbot.voiceStreamStop({ sessionId: sid, immediate: false });
      voiceSettling = false;
      voiceSessionId = null;
      if (voiceSettlingTimer) {
        clearTimeout(voiceSettlingTimer);
        voiceSettlingTimer = null;
      }
    }
    if (recPill) {
      recPill.style.display = 'none';
    }
    composerInput.focus();
  };

  // Send message (immediately aborts voice recording if active!)
  const sendAction = async () => {
    if (voiceActive || voiceStarting || voiceSettling) {
      await stopVoiceStreaming({ immediate: true });
    }
    voiceBaseText = '';
    voiceCommittedText = '';
    const input = document.getElementById('composerInput');
    const text = input.value.trim();
    const attachmentsToSend = [...(state.pendingAttachments || [])];
    if ((!text && attachmentsToSend.length === 0) || !state.activeSeatId) return;
    const replyMeta = state.activeReplyTo;
    state.activeReplyTo = null;
    const replyBanner = document.getElementById('replyQuoteBanner');
    if (replyBanner) replyBanner.style.display = 'none';
    if (state.draftBySeat) {
      delete state.draftBySeat[state.activeSeatId];
      try { localStorage.setItem('gravbot_drafts_v1', JSON.stringify(state.draftBySeat)); } catch (e) {}
    }
    input.value = '';
    input.style.height = 'auto';
    state.pendingAttachments = [];
    renderComposerAttachments();
    await window.gravbot.sendMessage({
      agentId: state.activeSeatId,
      content: text,
      attachments: attachmentsToSend,
      replyTo: replyMeta ? replyMeta.id : undefined,
      replyQuote: replyMeta ? replyMeta.quote : undefined
    });
  };

  document.getElementById('btnSend').addEventListener('click', sendAction);

  btnMic?.addEventListener('click', async () => {
    composerInput.focus();
    const result = await window.gravbot.startNativeDictation();
    if (!result.ok) showStatusToast('Dictation unavailable', result.error || 'Use your system dictation shortcut.');
  });

  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAction();
    }
  });
  composerInput.addEventListener('input', () => {
    composerInput.style.height = 'auto';
    composerInput.style.height = `${Math.min(150, composerInput.scrollHeight)}px`;
    if (state.activeSeatId) {
      state.draftBySeat[state.activeSeatId] = composerInput.value;
      try { localStorage.setItem('gravbot_drafts_v1', JSON.stringify(state.draftBySeat)); } catch (e) {}
    }
  });

  // Toggle right Conversation Details drawer
  document.getElementById('btnToggleInfoPane').addEventListener('click', () => {
    document.getElementById('inspectorPane').classList.toggle('collapsed');
  });

  document.getElementById('tokenCostPill')?.addEventListener('click', () => {
    document.getElementById('inspectorPane').classList.remove('collapsed');
    document.querySelectorAll('.insp-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.insp-content').forEach((c) => c.classList.remove('active'));
    document.querySelector('.insp-tab[data-tab="settings"]').classList.add('active');
    document.getElementById('tab-settings').classList.add('active');
    renderTokenCostUi();
  });

  document.getElementById('headerIdentityClick').addEventListener('click', () => {
    document.getElementById('inspectorPane').classList.remove('collapsed');
  });

  document.getElementById('btnComputerDrawer').addEventListener('click', () => {
    document.getElementById('inspectorPane').classList.remove('collapsed');
    document.querySelectorAll('.insp-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.insp-content').forEach((c) => c.classList.remove('active'));
    document.querySelector('.insp-tab[data-tab="workspace"]').classList.add('active');
    document.getElementById('tab-workspace').classList.add('active');
  });

  // Computer filter chips & Takeover modal controls
  document.querySelectorAll('#computerFilterRow .comp-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#computerFilterRow .comp-filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeComputerFilter = chip.dataset.filter || 'all';
      renderWorkspaceFiles();
    });
  });

  document.getElementById('btnOpenComputerTakeover')?.addEventListener('click', () => {
    openComputerTakeoverModal(activePreviewRelPath || 'findrequest-ux/ux/wireframes/b1.html');
  });

  document.getElementById('btnExpandFileToTakeover')?.addEventListener('click', () => {
    openComputerTakeoverModal(activePreviewRelPath);
  });

  document.getElementById('btnRevealFileFinder')?.addEventListener('click', () => {
    if (activePreviewRelPath) {
      window.gravbot.revealWorkspaceFile({ relPath: activePreviewRelPath, mode: 'finder' });
    }
  });

  document.getElementById('btnCloseComputerModal')?.addEventListener('click', () => {
    document.getElementById('computerTakeoverModal').style.display = 'none';
  });

  document.getElementById('btnComputerOpenBrowser')?.addEventListener('click', () => {
    if (activePreviewRelPath) {
      window.gravbot.revealWorkspaceFile({ relPath: activePreviewRelPath, mode: 'browser' });
    }
  });

  document.getElementById('btnComputerRevealFinder')?.addEventListener('click', () => {
    if (activePreviewRelPath) {
      window.gravbot.revealWorkspaceFile({ relPath: activePreviewRelPath, mode: 'finder' });
    }
  });

  document.querySelectorAll('.computer-viewport-bar .vp-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.computer-viewport-bar .vp-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const vp = btn.dataset.vp;
      const frame = document.getElementById('computerViewportFrame');
      if (frame) {
        frame.style.width = vp === 'fit' ? '100%' : `${vp}px`;
      }
    });
  });

  document.querySelectorAll('.insp-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.insp-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.insp-content').forEach((c) => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // Toggle inline Avatar Picker
  document.getElementById('btnToggleAvatarPicker').addEventListener('click', () => {
    const card = document.getElementById('avatarPickerCard');
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
  });

  // Save Bot Profile
  document.getElementById('btnSaveBotProfile').addEventListener('click', async () => {
    if (!state.activeSeatId) return;
    const chosenModel = document.getElementById('editBotModel')?.value || 'gemini-4-argon-low';
    const chosenEffort = chosenModel.endsWith('-high') ? 'high' : (chosenModel.endsWith('-medium') ? 'medium' : 'low');
    await window.gravbot.updateBot({
      id: state.activeSeatId,
      patch: {
        name: document.getElementById('editBotName').value.trim() || 'Bot',
        title: document.getElementById('editBotTitle').value.trim(),
        model: chosenModel,
        effort: chosenEffort,
        description: document.getElementById('editBotDesc').value.trim(),
        systemPrompt: document.getElementById('editBotPrompt').value.trim()
      }
    });
    const notice = document.getElementById('botSavedNotice');
    notice.textContent = '✓ Saved';
    setTimeout(() => { notice.textContent = ''; }, 2000);
  });

  document.getElementById('btnTogglePin').addEventListener('click', async () => {
    const seat = getSeatById(state.activeSeatId);
    if (!seat) return;
    await window.gravbot.updateBot({
      id: seat.id,
      patch: { isPinned: !seat.isPinned }
    });
  });

  document.getElementById('btnSetPrimary').addEventListener('click', async () => {
    if (!state.activeSeatId) return;
    await window.gravbot.setPrimaryBot(state.activeSeatId);
  });

  document.getElementById('btnClearChat').addEventListener('click', async () => {
    if (!state.activeSeatId) return;
    await window.gravbot.clearTranscript(state.activeSeatId);
    state.transcripts[state.activeSeatId] = [];
    renderTranscript();
  });

  document.getElementById('btnDeleteBot').addEventListener('click', async () => {
    const seat = getSeatById(state.activeSeatId);
    if (!seat || seat.isPrimary) return;
    const res = await window.gravbot.deleteBot(seat.id);
    if (res.ok) {
      selectSeat(state.primaryBotId);
    }
  });

  // New Bot / New Group Modals
  document.getElementById('btnNewBot').addEventListener('click', () => openCreateModal('bot'));
  document.getElementById('btnNewGroup').addEventListener('click', () => openCreateModal('group'));
  document.getElementById('btnCloseCreateModal').addEventListener('click', closeCreateModal);
  document.getElementById('btnCancelCreateModal').addEventListener('click', closeCreateModal);

  document.getElementById('btnConfirmCreateModal').addEventListener('click', async () => {
    const isGroup = state.modalMode === 'group';
    const name = document.getElementById('modalBotName').value.trim() || (isGroup ? 'New Group' : 'New Bot');
    const title = document.getElementById('modalBotTitle').value.trim() || (isGroup ? 'Group' : 'Bot');
    const systemPrompt = document.getElementById('modalBotPrompt').value.trim();
    const memberIds = isGroup
      ? Array.from(document.querySelectorAll('#modalGroupChecklist input:checked')).map((i) => i.value)
      : [];

    const res = await window.gravbot.createBot({
      name,
      title,
      description: title,
      systemPrompt,
      avatarShape: state.modalShape,
      avatarColor: state.modalColor,
      isGroup,
      memberIds
    });

    closeCreateModal();
    if (res.ok && res.bot) {
      selectSeat(res.bot.id);
    }
  });

  // Engine & Persistence Settings
  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    const patch = {
      agyPath: document.getElementById('settingAgyPath').value.trim(),
      effort: document.getElementById('settingEffort').value,
      skipPermissions: document.getElementById('settingSkipPermissions').checked
    };
    const res = await window.gravbot.updateSettings(patch);
    state.settings = res.appSettings;
    const notice = document.getElementById('settingsSavedNotice');
    notice.textContent = '✓ Saved';
    setTimeout(() => { notice.textContent = ''; }, 2000);
  });

  document.getElementById('btnRestoreCharacters').addEventListener('click', async () => {
    await window.gravbot.resetStudioMode('characters');
  });

  document.getElementById('btnResetFreshStudio').addEventListener('click', async () => {
    await window.gravbot.resetStudioMode('fresh');
  });

  // Live IPC Events
  window.gravbot.onEvent(({ type, data }) => {
    if (type === 'transcript-updated') {
      const { agentId, entry } = data;
      if (!state.transcripts[agentId]) state.transcripts[agentId] = [];
      if (!state.transcripts[agentId].some((x) => x.id === entry.id)) {
        state.transcripts[agentId].push(entry);
      }
      const isBotReply = entry.kind === 'send-message' || (entry.role && entry.role !== 'user');
      if (isBotReply) {
        state.unreadDoneBySeat[agentId] = true;
        playCompletionChime();
        const seat = getSeatById(agentId);
        const text = entry.content || (entry.message && entry.message.content) || '';
        if (seat && text) {
          showCompletionToast(seat, text);
        }
      }
      renderSidebar();
      if (state.activeSeatId === agentId) {
        renderTranscript();
      }
    } else if (type === 'roster-updated') {
      state.roster = data;
      svgCache.clear();
      renderSidebar();
      renderHeaderAndInspector();
    } else if (type === 'state-reset') {
      state.roster = data.roster || [];
      state.transcripts = data.transcripts || {};
      state.primaryBotId = data.primaryBotId || (state.roster[0] && state.roster[0].id);
      state.activeSeatId = state.primaryBotId;
      state.unreadDoneBySeat = {};
      state.botStatusBySeat = {};
      svgCache.clear();
      syncThinkingBar();
      renderSidebar();
      renderHeaderAndInspector();
      renderTranscript();
    } else if (type === 'bot-status') {
      const { agentId, state: botState } = data;
      state.botStatusBySeat[agentId] = botState;
      renderSidebar();
      syncThinkingBar();
      if (state.activeSeatId === agentId) {
        renderHeaderAndInspector();
      }
    } else if (type === 'usage-updated') {
      if (data && Array.isArray(data.roster)) {
        state.roster = data.roster;
      }
      renderTokenCostUi();
    } else if (type === 'workspace-files-updated') {
      if (data) {
        if (Array.isArray(data.droppedItems)) state.droppedItems = data.droppedItems;
        if (Array.isArray(data.workspaceFiles)) state.workspaceFiles = data.workspaceFiles;
        renderWorkspaceFiles();
      }
    } else if (type === 'voice-transcription') {
      if ((!voiceActive && !voiceSettling) || (data && data.sessionId && voiceSessionId && data.sessionId !== voiceSessionId)) {
        return;
      }
      if (data && data.transcription) {
        const { text = '', isFinal = false } = data.transcription;
        if (isFinal) {
          let seg = text;
          if (seg && !seg.endsWith(' ')) seg += ' ';
          voiceCommittedText += seg;
          const prefix = voiceBaseText ? `${voiceBaseText} ` : '';
          composerInput.value = `${prefix}${voiceCommittedText}`.trimStart();
        } else {
          const prefix = voiceBaseText ? `${voiceBaseText} ` : '';
          composerInput.value = `${prefix}${voiceCommittedText}${text}`.trimStart();
        }
        if (state.activeSeatId) {
          state.draftBySeat[state.activeSeatId] = composerInput.value;
        }
        composerInput.style.height = 'auto';
        composerInput.style.height = `${Math.min(150, composerInput.scrollHeight)}px`;
        composerInput.scrollTop = composerInput.scrollHeight;
      }
    }
  });
}

window.addEventListener('DOMContentLoaded', init);
