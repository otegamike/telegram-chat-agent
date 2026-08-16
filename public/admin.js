'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  username: null,
  prompts: [],
  chats: [],
  currentPrompt: null,
  editing: false,
  tab: 'prompts',
  settings: { autoSendDelayMs: 240000 },
};

const loginView = $('login-view');
const appView = $('app-view');
const who = $('who');
const logoutBtn = $('logout');
const promptListView = $('prompt-list');
const promptEditorTitle = $('prompt-editor-title');
const promptForm = $('prompt-form');
const promptError = $('prompt-error');
const fewShotRows = $('few-shot-rows');
const deletePromptBtn = $('delete-prompt');
const chatListView = $('chat-list');
const loginBtn = $('login-submit');
const logoutBtnEl = logoutBtn;

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* no json body */
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

function hideError(el) {
  el.hidden = true;
}

async function login() {
  hideError($('login-error'));
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  busy(loginBtn, true, 'Logging in…');
  try {
    const body = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    state.username = body.username;
    showApp();
  } catch (err) {
    showError($('login-error'), err.message);
  } finally {
    busy(loginBtn, false);
  }
}

async function logout() {
  busy(logoutBtnEl, true, 'Logging out…');
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    /* ignore */
  } finally {
    busy(logoutBtnEl, false);
  }
  state.username = null;
  showLogin();
}

async function loadPrompts() {
  showListLoading(promptListView, 'Loading prompts…');
  try {
    state.prompts = (await api('/api/prompts')) || [];
  } catch (err) {
    showError(promptError, `Failed to load prompts: ${err.message}`);
    state.prompts = [];
  }
  renderPromptList();
}

function showListLoading(listEl, message) {
  listEl.textContent = '';
  const li = document.createElement('li');
  li.className = 'list-item muted loading-hint';
  li.textContent = message;
  listEl.appendChild(li);
}

function renderPromptList() {
  promptListView.textContent = '';
  const sorted = [...state.prompts].sort((a, b) => {
    if (a.key === 'default') return -1;
    if (b.key === 'default') return 1;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  for (const p of sorted) {
    const li = document.createElement('li');
    li.className = 'list-item';
    if (state.currentPrompt && state.currentPrompt.key === p.key) {
      li.classList.add('active');
    }
    const title = document.createElement('span');
    title.className = 'li-title';
    title.textContent = p.name || p.key;
    const meta = document.createElement('small');
    meta.className = 'li-meta';
    const chat = p.chatId ? `chat ${p.chatId}` : 'global';
    const enabled = p.enabled ? 'enabled' : 'disabled';
    meta.textContent = `${p.key} — ${chat} — ${enabled}`;
    li.appendChild(title);
    li.appendChild(meta);
    li.addEventListener('click', () => selectPrompt(p));
    promptListView.appendChild(li);
  }
}

function findPromptByKey(key) {
  return state.prompts.find((p) => p.key === key) || null;
}

function findPromptById(id) {
  return state.prompts.find((p) => p.id === id) || null;
}

function freshPrompt() {
  return {
    key: '',
    name: '',
    chatId: null,
    systemPrompt: '',
    fewShotExamples: [],
    correctionsBlock: null,
    enabled: true,
  };
}

function renderFewShotRows(examples) {
  fewShotRows.textContent = '';
  const list = Array.isArray(examples) ? examples : [];
  for (const ex of list) {
    addFewShotRow(ex.trigger || '', ex.reply || '');
  }
  if (list.length === 0) {
    addFewShotRow();
  }
}

function addFewShotRow(trigger, reply) {
  const row = document.createElement('div');
  row.className = 'few-shot-row';
  const triggerInput = document.createElement('input');
  triggerInput.type = 'text';
  triggerInput.placeholder = 'Incoming message';
  triggerInput.value = trigger || '';
  triggerInput.className = 'grow';
  const replyInput = document.createElement('input');
  replyInput.type = 'text';
  replyInput.placeholder = 'Your reply';
  replyInput.value = reply || '';
  replyInput.className = 'grow';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn small danger';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => row.remove());
  row.appendChild(triggerInput);
  row.appendChild(replyInput);
  row.appendChild(removeBtn);
  fewShotRows.appendChild(row);
}

function collectFewShot() {
  const examples = [];
  for (const row of fewShotRows.children) {
    const inputs = row.querySelectorAll('input');
    const trigger = inputs[0].value.trim();
    const reply = inputs[1].value.trim();
    if (trigger && reply) {
      examples.push({ trigger, reply });
    }
  }
  return examples;
}

function showEditor() {
  promptEditorTitle.textContent = state.editing
    ? `Prompt: ${state.currentPrompt.name || state.currentPrompt.key}`
    : 'New prompt';
  promptForm.hidden = false;
  deletePromptBtn.hidden = !state.editing;
  hideError(promptError);
}

function clearEditor() {
  $('f-key').value = '';
  $('f-key').disabled = false;
  $('f-name').value = '';
  $('f-chatid').value = '';
  $('f-enabled').checked = true;
  $('f-system').value = '';
  $('f-corrections').value = '';
  renderFewShotRows([]);
}

function selectPrompt(p) {
  state.currentPrompt = p;
  state.editing = true;
  $('f-key').value = p.key;
  $('f-key').disabled = true;
  $('f-name').value = p.name || '';
  $('f-chatid').value = p.chatId || '';
  $('f-enabled').checked = !!p.enabled;
  $('f-system').value = p.systemPrompt || '';
  $('f-corrections').value = p.correctionsBlock || '';
  renderFewShotRows(p.fewShotExamples);
  showEditor();
  renderPromptList();
}

function startNewPrompt() {
  state.currentPrompt = freshPrompt();
  state.editing = false;
  clearEditor();
  showEditor();
  renderPromptList();
}

async function savePrompt(evt) {
  evt.preventDefault();
  hideError(promptError);
  const saveBtn = promptForm.querySelector('button[type="submit"]');
  const keyRaw = $('f-key').value.trim();
  const payload = {
    name: $('f-name').value.trim(),
    chatId: $('f-chatid').value.trim() || null,
    enabled: $('f-enabled').checked,
    systemPrompt: $('f-system').value,
    fewShotExamples: collectFewShot(),
    correctionsBlock: $('f-corrections').value.trim() || null,
  };
  busy(saveBtn, true, 'Saving…');
  try {
    if (state.editing) {
      const id = state.currentPrompt.id;
      const saved = await api(`/api/prompts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      const idx = state.prompts.findIndex((p) => p.id === id);
      state.prompts[idx] = saved;
      state.prompts[idx].key = state.currentPrompt.key;
      state.currentPrompt = { ...state.currentPrompt, ...saved };
    } else {
      const saved = await api('/api/prompts', {
        method: 'POST',
        body: JSON.stringify({ key: keyRaw, ...payload }),
      });
      state.prompts.push(saved);
      state.currentPrompt = saved;
      state.editing = true;
      $('f-key').value = saved.key;
      $('f-key').disabled = true;
    }
    renderPromptList();
    showEditor();
    toast('Prompt saved');
  } catch (err) {
    showError(promptError, err.message);
  } finally {
    busy(saveBtn, false);
  }
}

async function deletePrompt() {
  if (!state.editing || !state.currentPrompt) return;
  if (!window.confirm(`Delete prompt "${state.currentPrompt.name || state.currentPrompt.key}"?`)) {
    return;
  }
  hideError(promptError);
  const id = state.currentPrompt.id;
  busy(deletePromptBtn, true, 'Deleting…');
  try {
    await api(`/api/prompts/${id}`, { method: 'DELETE' });
    state.prompts = state.prompts.filter((p) => p.id !== id);
    state.currentPrompt = null;
    state.editing = false;
    promptForm.hidden = true;
    promptEditorTitle.textContent = 'Select a prompt';
    renderPromptList();
    toast('Prompt deleted');
  } catch (err) {
    showError(promptError, err.message);
  } finally {
    busy(deletePromptBtn, false);
  }
}

async function loadChats() {
  showListLoading(chatListView, 'Loading chats…');
  try {
    state.chats = (await api('/api/chat-configs')) || [];
  } catch (err) {
    console.error('Failed to load chats:', err);
    state.chats = [];
  }
  renderChatList();
  loadChatDirectory();
}

let chatDirectory = [];
let dirLastSyncAt = null;

async function loadChatDirectory() {
  const picker = $('chat-picker');
  if (!picker) return;
  const syncInfo = $('chat-sync-info');
  try {
    const body = await api('/api/chats');
    chatDirectory = body.chats || [];
    dirLastSyncAt = body.lastSyncAt || null;
  } catch (err) {
    chatDirectory = [];
    syncInfo.textContent = `Could not load chat list: ${err.message}`;
    return;
  }

  const selected = picker.value;
  picker.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a chat…';
  picker.appendChild(placeholder);
  for (const c of chatDirectory) {
    const opt = document.createElement('option');
    opt.value = c.chatId;
    opt.textContent = c.displayName;
    picker.appendChild(opt);
  }

  if (chatDirectory.length === 0) {
    syncInfo.textContent = 'No chats synced yet — run `npm start` (or `npm run sync-chats`) to populate the chat list.';
  } else {
    const when = dirLastSyncAt
      ? `Last synced ${new Date(dirLastSyncAt).toLocaleString()}`
      : 'Last synced recently';
    syncInfo.textContent = `${when} — updated whenever the service runs.`;
  }

  if (selected) {
    picker.value = selected;
  }
}

function renderChatList() {
  chatListView.textContent = '';
  if (state.chats.length === 0) {
    const li = document.createElement('li');
    li.className = 'list-item muted';
    li.textContent = 'No chats in the allow-list yet.';
    chatListView.appendChild(li);
    return;
  }
  for (const c of state.chats) {
    const li = document.createElement('li');
    li.className = 'list-item';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn small';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => {
      window.location.href = `/chat.html?chatId=${encodeURIComponent(c.chatId)}`;
    });

    const chatInfo = document.createElement('span');
    chatInfo.className = 'grow';
    chatInfo.textContent = `${c.chatId}${c.peerUsername ? ' (@' + c.peerUsername + ')' : ''}`;

    const toggle = document.createElement('label');
    toggle.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!c.autoReplyEnabled;
    cb.addEventListener('change', () => saveChat(c, { autoReplyEnabled: cb.checked }, cb));
    toggle.appendChild(cb);
    toggle.appendChild(document.createTextNode(' Auto-reply'));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn small danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeChat(c.id, c.chatId, li));

    li.appendChild(openBtn);
    li.appendChild(chatInfo);
    li.appendChild(toggle);
    li.appendChild(removeBtn);
    chatListView.appendChild(li);
  }
}

async function saveChat(chat, patch, cb) {
  const previous = chat.autoReplyEnabled;
  cb.disabled = true;
  try {
    const saved = await api(
      `/api/chat-configs/${encodeURIComponent(chat.chatId)}`,
      { method: 'PUT', body: JSON.stringify(patch) }
    );
    chat.autoReplyEnabled = saved.autoReplyEnabled;
    chat.peerUsername = saved.peerUsername || '';
    cb.checked = !!saved.autoReplyEnabled;
    toast('Auto-reply updated');
  } catch (err) {
    cb.checked = previous;
    toast(err.message, 'error');
  } finally {
    cb.disabled = false;
  }
}

function onChatPicked() {
  const chatId = $('chat-picker').value;
  if (!chatId) return;
  const chat = chatDirectory.find((c) => c.chatId === chatId);
  $('chat-add-id').value = chatId;
  $('chat-add-user').value = (chat && chat.username) || '';
  $('chat-add-form').requestSubmit();
}

async function addChat(evt) {
  evt.preventDefault();
  const chatId = $('chat-add-id').value.trim();
  const peerUsername = $('chat-add-user').value.trim();
  if (!chatId) return;
  const btn = $('chat-add-form').querySelector('button[type="submit"]');
  busy(btn, true, 'Adding…');
  try {
    const saved = await api(`/api/chat-configs/${encodeURIComponent(chatId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        peerUsername,
        autoReplyEnabled: true,
      }),
    });
    const existing = state.chats.find((c) => c.chatId === saved.chatId);
    if (existing) {
      Object.assign(existing, saved);
    } else {
      state.chats.push(saved);
    }
    $('chat-add-id').value = '';
    $('chat-add-user').value = '';
    renderChatList();
    toast('Chat added');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    busy(btn, false);
  }
}

async function removeChat(id, chatId, li) {
  if (!window.confirm(`Remove chat ${chatId} from the allow-list?`)) return;
  const btn = li.querySelector('button.danger');
  busy(btn, true, 'Removing…');
  try {
    await api(`/api/chat-configs/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
    state.chats = state.chats.filter((c) => c.id !== id);
    renderChatList();
    toast('Chat removed');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    busy(btn, false);
  }
}

async function loadSettings() {
  hideError($('settings-error'));
  const saveBtn = $('settings-form').querySelector('button[type="submit"]');
  busy(saveBtn, true, 'Loading…');
  try {
    state.settings = (await api('/api/settings')) || state.settings;
    $('auto-send-delay').value = state.settings.autoSendDelayMs;
  } catch (err) {
    toast(`Failed to load settings: ${err.message}`, 'error');
  } finally {
    busy(saveBtn, false);
  }
}

async function saveSettings(evt) {
  evt.preventDefault();
  hideError($('settings-error'));
  const autoSendDelayMs = Number($('auto-send-delay').value);
  if (!Number.isFinite(autoSendDelayMs) || autoSendDelayMs < 0) {
    showError($('settings-error'), 'Delay must be a non-negative number (0 disables auto-send).');
    return;
  }
  const saveBtn = $('settings-form').querySelector('button[type="submit"]');
  busy(saveBtn, true, 'Saving…');
  try {
    state.settings = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ autoSendDelayMs }),
    });
    $('auto-send-delay').value = state.settings.autoSendDelayMs;
    toast('Settings saved');
  } catch (err) {
    showError($('settings-error'), err.message);
  } finally {
    busy(saveBtn, false);
  }
}

function showLogin() {
  loginView.hidden = false;
  appView.hidden = true;
  logoutBtn.hidden = true;
  who.textContent = '';
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  logoutBtn.hidden = false;
  who.textContent = state.username ? `Signed in as ${state.username}` : '';
  loadPrompts();
  loadChats();
  loadSettings();
}

function switchTab(tab) {
  state.tab = tab;
  $('tab-prompts').classList.toggle('active', tab === 'prompts');
  $('tab-chats').classList.toggle('active', tab === 'chats');
  $('tab-settings').classList.toggle('active', tab === 'settings');
  $('prompts-view').hidden = tab !== 'prompts';
  $('chats-view').hidden = tab !== 'chats';
  $('settings-view').hidden = tab !== 'settings';
}

function bindEvents() {
  $('login-form').addEventListener('submit', (evt) => {
    evt.preventDefault();
    login();
  });
  logoutBtn.addEventListener('click', logout);
  $('tab-prompts').addEventListener('click', () => switchTab('prompts'));
  $('tab-chats').addEventListener('click', () => switchTab('chats'));
  $('tab-settings').addEventListener('click', () => switchTab('settings'));
  $('new-prompt').addEventListener('click', startNewPrompt);
  promptForm.addEventListener('submit', savePrompt);
  deletePromptBtn.addEventListener('click', deletePrompt);
  $('add-example').addEventListener('click', () => addFewShotRow());
  $('chat-add-form').addEventListener('submit', addChat);
  $('chat-picker').addEventListener('change', onChatPicked);
  $('chat-refresh').addEventListener('click', loadChatDirectory);
  $('settings-form').addEventListener('submit', saveSettings);
}

async function init() {
  bindEvents();
  try {
    const me = await api('/api/me');
    state.username = me.username;
    showApp();
  } catch (err) {
    if (err.status === 401) {
      showLogin();
    } else {
      showError($('login-error'), `Cannot reach admin server: ${err.message}`);
      showLogin();
    }
  }
}

init();