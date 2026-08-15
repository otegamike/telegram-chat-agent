'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  chatId: null,
  username: null,
  data: null,
  prompt: null,
  editing: false,
};

const loginView = $('login-view');
const chatView = $('chat-view');
const who = $('who');
const logoutBtn = $('logout');
const promptForm = $('prompt-form');
const promptError = $('prompt-error');
const fewShotRows = $('few-shot-rows');
const createChatPromptBtn = $('create-chat-prompt');

function chatIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('chatId') || null;
}

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
  try {
    const body = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    state.username = body.username;
    showChat();
  } catch (err) {
    showError($('login-error'), err.message);
  }
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  state.username = null;
  showLogin();
}

function showLogin() {
  loginView.hidden = false;
  chatView.hidden = true;
  logoutBtn.hidden = true;
  who.textContent = '';
}

function showChat() {
  loginView.hidden = true;
  chatView.hidden = false;
  logoutBtn.hidden = false;
  who.textContent = state.username ? `Signed in as ${state.username}` : '';
  loadChat();
}

async function loadChat() {
  hideError($('chat-load-error'));
  try {
    state.data = await api(`/api/chat/${encodeURIComponent(state.chatId)}`);
  } catch (err) {
    showError($('chat-load-error'), `Failed to load chat: ${err.message}`);
    return;
  }
  renderHeader();
  renderPrompt();
  renderHistory();
  renderDrafts();
}

function renderHeader() {
  const chat = state.data.chat || {};
  const config = state.data.config || {};
  const displayName = chat.displayName || config.peerUsername || state.chatId;
  const meta = [
    state.chatId,
    chat.username ? `@${chat.username}` : null,
    config.peerUsername && config.peerUsername !== chat.username
      ? `username: @${config.peerUsername}`
      : null,
  ]
    .filter(Boolean)
    .join(' — ');
  $('chat-title').textContent = displayName;
  $('chat-meta').textContent = meta || state.chatId;

  const cb = $('auto-reply');
  cb.checked = !!config.autoReplyEnabled;
  cb.onchange = async () => {
    try {
      const saved = await api(`/api/chat-configs/${encodeURIComponent(state.chatId)}`, {
        method: 'PUT',
        body: JSON.stringify({ autoReplyEnabled: cb.checked }),
      });
      cb.checked = !!saved.autoReplyEnabled;
    } catch (err) {
      cb.checked = !cb.checked;
      window.alert(`Failed to update auto-reply: ${err.message}`);
    }
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

function fillPromptForm(p) {
  $('f-key').value = p.key;
  $('f-key').disabled = true;
  $('f-name').value = p.name || '';
  $('f-enabled').checked = !!p.enabled;
  $('f-system').value = p.systemPrompt || '';
  $('f-corrections').value = p.correctionsBlock || '';
  renderFewShotRows(p.fewShotExamples);
}

function renderPrompt() {
  const chatPrompt = state.data.chatPrompt;
  const defaultPrompt = state.data.defaultPrompt;
  state.prompt = chatPrompt || defaultPrompt;
  state.editing = !!chatPrompt;

  $('prompt-fallback').hidden = !!chatPrompt;
  $('prompt-fallback').textContent = chatPrompt
    ? ''
    : `This chat uses the global default prompt ("${defaultPrompt?.name || defaultPrompt?.key || 'default'}"). Click "Create chat-specific prompt" to give it its own voice.`;

  promptForm.hidden = false;
  createChatPromptBtn.hidden = !!chatPrompt;
  hideError(promptError);
  fillPromptForm(state.prompt);
}

async function savePrompt(evt) {
  evt.preventDefault();
  hideError(promptError);
  const payload = {
    name: $('f-name').value.trim(),
    enabled: $('f-enabled').checked,
    systemPrompt: $('f-system').value,
    fewShotExamples: collectFewShot(),
    correctionsBlock: $('f-corrections').value.trim() || null,
  };
  try {
    if (state.editing) {
      const saved = await api(`/api/prompts/${state.prompt.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      state.prompt = saved;
      state.data.chatPrompt = saved;
      $('f-key').value = saved.key;
    } else {
      const saved = await api('/api/prompts', {
        method: 'POST',
        body: JSON.stringify({
          key: state.chatId,
          chatId: state.chatId,
          ...payload,
        }),
      });
      state.data.chatPrompt = saved;
      state.prompt = saved;
      state.editing = true;
      $('f-key').value = saved.key;
      createChatPromptBtn.hidden = true;
      $('prompt-fallback').hidden = true;
    }
    renderPrompt();
  } catch (err) {
    showError(promptError, err.message);
  }
}

async function createChatPrompt() {
  hideError(promptError);
  const source = state.data.defaultPrompt;
  try {
    const created = await api('/api/prompts', {
      method: 'POST',
      body: JSON.stringify({
        key: state.chatId,
        name: `Chat ${state.chatId}`,
        chatId: state.chatId,
        enabled: true,
        systemPrompt: source?.systemPrompt || '',
        fewShotExamples: source?.fewShotExamples || [],
        correctionsBlock: source?.correctionsBlock || null,
      }),
    });
    state.data.chatPrompt = created;
    state.data.chatId = state.chatId;
    state.prompt = created;
    state.editing = true;
    renderPrompt();
  } catch (err) {
    showError(promptError, err.message);
  }
}

function renderHistory() {
  const conv = state.data.conversation;
  const summaryEl = $('history-summary');
  summaryEl.hidden = !conv || !conv.summary;
  summaryEl.textContent = conv && conv.summary ? `Summary: ${conv.summary}` : '';

  const historyEl = $('history');
  historyEl.textContent = '';
  if (!conv || !conv.messages || conv.messages.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No messages yet for this chat.';
    historyEl.appendChild(empty);
    return;
  }

  for (const m of conv.messages) {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${m.role === 'me' ? 'bubble-me' : 'bubble-them'}`;
    bubble.textContent = m.text;
    const time = document.createElement('div');
    time.className = 'bubble-time muted';
    time.textContent = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
    historyEl.appendChild(bubble);
    historyEl.appendChild(time);
  }
}

function statusBadge(status) {
  const labels = { pending: 'Pending', sent: 'Sent', skipped: 'Skipped' };
  return labels[status] || status;
}

function renderDrafts() {
  const listEl = $('drafts');
  listEl.textContent = '';
  const drafts = state.data.drafts || [];
  if (drafts.length === 0) {
    const li = document.createElement('li');
    li.className = 'list-item muted';
    li.textContent = 'No corrections yet.';
    listEl.appendChild(li);
    return;
  }
  for (const d of drafts) {
    const li = document.createElement('li');
    li.className = 'list-item draft';

    const header = document.createElement('div');
    const badge = document.createElement('span');
    badge.className = `badge badge-${d.status}`;
    badge.textContent = statusBadge(d.status) + (d.wasEdited ? ' / Edited' : '');
    const when = document.createElement('span');
    when.className = 'li-meta';
    when.textContent = d.createdAt ? new Date(d.createdAt).toLocaleString() : '';
    header.appendChild(badge);
    header.appendChild(when);

    const incoming = document.createElement('div');
    incoming.className = 'draft-line';
    incoming.innerHTML =
      `<strong>In:</strong> ${escapeHtml(d.incomingMessage)}<br>` +
      `<strong>Draft:</strong> ${escapeHtml(d.draftText)}`;

    li.appendChild(header);
    li.appendChild(incoming);
    if (d.wasEdited && d.finalText) {
      const edited = document.createElement('div');
      edited.className = 'draft-line edited';
      edited.innerHTML = `<strong>Your correction:</strong> ${escapeHtml(d.finalText)}`;
      li.appendChild(edited);
    }
    listEl.appendChild(li);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bindEvents() {
  $('login-form').addEventListener('submit', (evt) => {
    evt.preventDefault();
    login();
  });
  logoutBtn.addEventListener('click', logout);
  promptForm.addEventListener('submit', savePrompt);
  createChatPromptBtn.addEventListener('click', createChatPrompt);
  $('add-example').addEventListener('click', () => addFewShotRow());
}

async function init() {
  state.chatId = chatIdFromUrl();
  if (!state.chatId) {
    window.location.href = '/admin';
    return;
  }
  bindEvents();
  try {
    const me = await api('/api/me');
    state.username = me.username;
    showChat();
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