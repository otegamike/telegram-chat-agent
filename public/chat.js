'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  chatId: null,
  username: null,
  data: null,
  prompt: null,
  prompts: [],
  editing: false,
};

const loginView = $('login-view');
const chatView = $('chat-view');
const who = $('who');
const logoutBtn = $('logout');
const promptForm = $('prompt-form');
const promptError = $('prompt-error');
const fewShotRows = $('few-shot-rows');
const loginBtn = $('login-submit');

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
  busy(loginBtn, true, 'Logging in…');
  try {
    const body = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    state.username = body.username;
    showChat();
  } catch (err) {
    showError($('login-error'), err.message);
  } finally {
    busy(loginBtn, false);
  }
}

async function logout() {
  busy(logoutBtn, true, 'Logging out…');
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  state.username = null;
  showLogin();
  busy(logoutBtn, false);
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
  $('chat-title').textContent = 'Loading chat…';
  try {
    state.data = await api(`/api/chat/${encodeURIComponent(state.chatId)}`);
  } catch (err) {
    showError($('chat-load-error'), `Failed to load chat: ${err.message}`);
    $('chat-title').textContent = 'Chat';
    return;
  }
  renderHeader();
  await loadPrompts();
  renderPrompt();
  renderHistory();
  renderDrafts();
}

async function loadPrompts() {
  try {
    state.prompts = (await api('/api/prompts')) || [];
  } catch (err) {
    state.prompts = [];
    toast(`Failed to load prompts: ${err.message}`, 'error');
  }
  renderPromptPicker();
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
    cb.disabled = true;
    try {
      const saved = await api(`/api/chat-configs/${encodeURIComponent(state.chatId)}`, {
        method: 'PUT',
        body: JSON.stringify({ autoReplyEnabled: cb.checked }),
      });
      cb.checked = !!saved.autoReplyEnabled;
      toast('Auto-reply updated');
    } catch (err) {
      cb.checked = !cb.checked;
      toast(err.message, 'error');
    } finally {
      cb.disabled = false;
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
  $('f-name').value = p.name || '';
  $('f-enabled').checked = !!p.enabled;
  $('f-system').value = p.systemPrompt || '';
  $('f-corrections').value = p.correctionsBlock || '';
  renderFewShotRows(p.fewShotExamples);
}

function promptLabel(p) {
  const name = p.name || p.key;
  if (!p.chatId) return `${name} (global)`;
  if (p.chatId === state.chatId) return `${name} (this chat)`;
  return `${name} (${p.chatId})`;
}

function renderPromptPicker() {
  const picker = $('prompt-picker');
  const currentKey = state.prompt ? state.prompt.key : '';
  picker.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a prompt…';
  picker.appendChild(placeholder);
  for (const p of state.prompts) {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.textContent = promptLabel(p);
    opt.selected = p.key === currentKey;
    picker.appendChild(opt);
  }
}

async function onPromptPicked() {
  const picker = $('prompt-picker');
  const key = picker.value;
  if (!key) return;
  const currentKey = state.prompt ? state.prompt.key : '';
  if (key === currentKey) return;
  const source = state.prompts.find((p) => p.key === key);
  if (!source) return;
  const chat = state.data.chat || {};
  const config = state.data.config || {};
  const username = chat.username || config.peerUsername || state.chatId;
  const name = `${username}_prompt`;
  const payload = {
    name,
    chatId: state.chatId,
    systemPrompt: source.systemPrompt || '',
    fewShotExamples: source.fewShotExamples || [],
    correctionsBlock: source.correctionsBlock || null,
    enabled: true,
  };
  hideError(promptError);
  picker.disabled = true;
  toast('Copying prompt…');
  try {
    if (state.editing && state.prompt && state.data.chatPrompt) {
      state.data.chatPrompt = await api(`/api/prompts/${state.data.chatPrompt.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      state.data.chatPrompt = await api('/api/prompts', {
        method: 'POST',
        body: JSON.stringify({ key: state.chatId, ...payload }),
      });
      state.prompts.push(state.data.chatPrompt);
    }
    state.prompt = state.data.chatPrompt;
    state.editing = true;
    renderPrompt();
    renderPromptPicker();
    toast(`Prompt "${source.name || key}" copied to this chat`);
  } catch (err) {
    toast(err.message, 'error');
    state.prompt = state.data.chatPrompt || state.data.defaultPrompt;
    state.editing = !!state.data.chatPrompt;
    renderPromptPicker();
  } finally {
    picker.disabled = false;
  }
}

function renderPrompt() {
  const chatPrompt = state.data.chatPrompt;
  const defaultPrompt = state.data.defaultPrompt;
  state.prompt = chatPrompt || defaultPrompt;
  state.editing = !!chatPrompt;

  $('prompt-fallback').hidden = !!chatPrompt;
  $('prompt-fallback').textContent = chatPrompt
    ? ''
    : `This chat uses the global default prompt ("${defaultPrompt?.name || defaultPrompt?.key || 'default'}"). Pick a prompt above to give it its own voice.`;

  promptForm.hidden = false;
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
  const saveBtn = promptForm.querySelector('button[type="submit"]');
  busy(saveBtn, true, 'Saving…');
  try {
    if (state.editing) {
      const saved = await api(`/api/prompts/${state.prompt.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      state.prompt = saved;
      state.data.chatPrompt = saved;
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
      $('prompt-fallback').hidden = true;
    }
    renderPrompt();
    renderPromptPicker();
    toast('Prompt saved');
  } catch (err) {
    showError(promptError, err.message);
  } finally {
    busy(saveBtn, false);
  }
}

function renderHistory() {
  const conv = state.data.conversation;
  renderTopics(conv);
  renderMessages(conv);
}

function renderTopics(conv) {
  const listEl = $('topic-list');
  const emptyEl = $('topic-empty');
  listEl.textContent = '';
  const topics = (conv && conv.topics) || [];
  listEl.hidden = topics.length === 0;
  emptyEl.hidden = topics.length > 0;
  emptyEl.textContent = topics.length === 0
    ? 'No topics yet. Topics are extracted automatically as this chat\'s history grows, or add your own context below.'
    : '';
  for (const t of topics) {
    listEl.appendChild(renderTopicItem(t));
  }
}

function renderTopicItem(t) {
  const li = document.createElement('li');
  li.className = 'list-item topic' + (t.archived ? ' muted' : '');
  li.dataset.topicId = t.topicId || '';

  const head = document.createElement('div');
  head.className = 'topic-header';

  const titleBox = document.createElement('div');
  const title = document.createElement('span');
  title.className = 'li-title';
  title.textContent = t.label;
  titleBox.appendChild(title);
  if (t.archived) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'archived';
    titleBox.appendChild(badge);
  }

  const actions = document.createElement('span');
  actions.className = 'topic-actions';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn small';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => renderTopicEdit(li, t));

  const archiveBtn = document.createElement('button');
  archiveBtn.type = 'button';
  archiveBtn.className = 'btn small';
  archiveBtn.textContent = t.archived ? 'Unarchive' : 'Archive';
  archiveBtn.addEventListener('click', () => {
    busy(archiveBtn, true, '…');
    api(`/api/chat/${encodeURIComponent(state.chatId)}/topics/${encodeURIComponent(t.topicId)}`, {
      method: 'PUT',
      body: JSON.stringify({ archived: !t.archived }),
    })
      .then(() => {
        toast(t.archived ? 'Topic unarchived' : 'Topic archived');
        return loadTopics();
      })
      .catch((err) => {
        busy(archiveBtn, false);
        toast(err.message, 'error');
      });
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn small danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => {
    if (!window.confirm(`Delete topic "${t.label}"?`)) return;
    busy(deleteBtn, true, 'Deleting…');
    api(`/api/chat/${encodeURIComponent(state.chatId)}/topics/${encodeURIComponent(t.topicId)}`, {
      method: 'DELETE',
    })
      .then(() => {
        toast('Topic deleted');
        return loadTopics();
      })
      .catch((err) => {
        busy(deleteBtn, false);
        toast(err.message, 'error');
      });
  });

  actions.appendChild(editBtn);
  actions.appendChild(archiveBtn);
  actions.appendChild(deleteBtn);
  head.appendChild(titleBox);
  head.appendChild(actions);

  const meta = document.createElement('small');
  meta.className = 'li-meta';
  meta.textContent = t.lastMentioned
    ? `Last mentioned ${new Date(t.lastMentioned).toLocaleString()}`
    : '';

  const desc = document.createElement('div');
  desc.textContent = t.summary;

  li.appendChild(head);
  li.appendChild(meta);
  li.appendChild(desc);
  return li;
}

function renderTopicEdit(li, t) {
  li.textContent = '';
  li.className = 'list-item topic topic-editing';

  const labelEl = document.createElement('label');
  labelEl.textContent = 'Label:';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.value = t.label || '';
  labelInput.placeholder = 'e.g. work projects';

  const summaryLabel = document.createElement('label');
  summaryLabel.textContent = 'Summary:';
  const summaryInput = document.createElement('textarea');
  summaryInput.value = t.summary || '';
  summaryInput.rows = 3;
  summaryInput.placeholder = 'Short context notes about this topic';

  const actions = document.createElement('div');
  actions.className = 'actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn primary small';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => {
    const label = labelInput.value.trim();
    const summary = summaryInput.value.trim();
    if (!label || !summary) {
      toast('Both label and summary are required.', 'error');
      return;
    }
    busy(saveBtn, true, 'Saving…');
    saveTopic(t, { label, summary })
      .then(() => toast('Topic saved'))
      .catch((err) => {
        busy(saveBtn, false);
        toast(err.message, 'error');
      });
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn small';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', loadTopics);

  li.appendChild(labelEl);
  li.appendChild(labelInput);
  li.appendChild(summaryLabel);
  li.appendChild(summaryInput);
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  li.appendChild(actions);
}

async function loadTopics() {
  try {
    const body = await api(`/api/chat/${encodeURIComponent(state.chatId)}/topics`);
    if (!state.data.conversation) {
      state.data.conversation = { messages: [], topics: [] };
    }
    state.data.conversation.topics = body.topics || [];
  } catch (err) {
    toast(`Failed to load topics: ${err.message}`, 'error');
  }
  renderTopics(state.data.conversation);
}

async function saveTopic(t, payload) {
  const hasId = !!t.topicId;
  const url = hasId
    ? `/api/chat/${encodeURIComponent(state.chatId)}/topics/${encodeURIComponent(t.topicId)}`
    : `/api/chat/${encodeURIComponent(state.chatId)}/topics`;
  await api(url, {
    method: hasId ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
  });
  await loadTopics();
}

function addTopic() {
  $('topic-empty').hidden = true;
  const listEl = $('topic-list');
  listEl.hidden = false;
  const li = document.createElement('li');
  li.className = 'list-item topic topic-editing';
  listEl.insertBefore(li, listEl.firstChild);
  renderTopicEdit(li, { topicId: '', label: '', summary: '' });
}

function renderMessages(conv) {
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

function serializeDraftShape(d) {
  return {
    id: d.id,
    chatId: d.chatId || state.chatId,
    incomingMessage: d.incomingMessage,
    draftText: d.draftText,
    finalText: d.finalText ?? null,
    status: d.status,
    wasEdited: d.wasEdited,
    createdAt: d.createdAt,
  };
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
    listEl.appendChild(renderDraftItem(d));
  }
}

function renderDraftItem(d) {
  const li = document.createElement('li');
  li.className = 'list-item draft';
  li.dataset.draftId = d.id;
  renderDraftRead(li, d);
  return li;
}

function renderDraftRead(li, d) {
  li.textContent = '';
  li.className = 'list-item draft';

  const header = document.createElement('div');
  header.className = 'draft-header';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn small';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => {
    renderDraftEdit(li, d);
  });

  const badge = document.createElement('span');
  badge.className = `badge badge-${d.status}`;
  badge.textContent = statusBadge(d.status) + (d.wasEdited ? ' / Edited' : '');
  const when = document.createElement('span');
  when.className = 'li-meta';
  when.textContent = d.createdAt ? new Date(d.createdAt).toLocaleString() : '';

  header.appendChild(editBtn);
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
}

function renderDraftEdit(li, d) {
  li.textContent = '';
  li.className = 'list-item draft draft-editing';

  const inLabel = document.createElement('label');
  inLabel.textContent = 'In:';
  const inInput = document.createElement('textarea');
  inInput.value = d.incomingMessage;
  inInput.rows = 2;

  const draftLabel = document.createElement('label');
  draftLabel.textContent = 'Draft:';
  const draftInput = document.createElement('textarea');
  draftInput.value = d.draftText;
  draftInput.rows = 2;

  const finalLabel = document.createElement('label');
  finalLabel.textContent = 'Your correction:';
  const finalInput = document.createElement('textarea');
  finalInput.value = d.finalText || '';
  finalInput.rows = 2;
  finalInput.placeholder = 'Leave blank if you did not correct this draft';

  const statusLabel = document.createElement('label');
  statusLabel.textContent = 'Status:';
  const statusSelect = document.createElement('select');
  for (const s of ['skipped', 'sent']) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = statusBadge(s);
    opt.selected = d.status === s;
    statusSelect.appendChild(opt);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn primary small';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => {
    const incomingMessage = inInput.value.trim();
    const draftText = draftInput.value.trim();
    if (!incomingMessage || !draftText) {
      toast('Both In and Draft text are required.', 'error');
      return;
    }
    const payload = {
      incomingMessage,
      draftText,
      finalText: finalInput.value.trim() || null,
      status: statusSelect.value,
    };
    busy(saveBtn, true, 'Saving…');
    const request = d.id
      ? api(`/api/drafts/${encodeURIComponent(d.id)}`, { method: 'PUT', body: JSON.stringify(payload) })
      : api('/api/drafts', {
          method: 'POST',
          body: JSON.stringify({ chatId: state.chatId, ...payload }),
        });
    request
      .then(() => {
        toast('Correction saved');
        return loadChat();
      })
      .catch((err) => {
        busy(saveBtn, false);
        toast(err.message, 'error');
      });
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn small';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    if (d.id) {
      renderDraftRead(li, d);
    } else {
      li.remove();
    }
  });

  li.appendChild(inLabel);
  li.appendChild(inInput);
  li.appendChild(draftLabel);
  li.appendChild(draftInput);
  li.appendChild(finalLabel);
  li.appendChild(finalInput);
  li.appendChild(statusLabel);
  li.appendChild(statusSelect);
  actions.appendChild(saveBtn);

  if (d.id) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn small danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      if (!window.confirm('Delete this correction?')) return;
      busy(deleteBtn, true, 'Deleting…');
      api(`/api/drafts/${encodeURIComponent(d.id)}`, { method: 'DELETE' })
        .then(() => {
          toast('Correction deleted');
          return loadChat();
        })
        .catch((err) => {
          busy(deleteBtn, false);
          toast(err.message, 'error');
        });
    });
    actions.appendChild(deleteBtn);
  }

  actions.appendChild(cancelBtn);
  li.appendChild(actions);
}

function addCorrection() {
  const listEl = $('drafts');
  if (listEl.children.length > 0 && listEl.children[0].textContent === 'No corrections yet.') {
    listEl.textContent = '';
  }
  const li = makeBlankDraftLi();
  listEl.appendChild(li);
  renderDraftEdit(li, {
    id: null,
    chatId: state.chatId,
    incomingMessage: '',
    draftText: '',
    finalText: null,
    status: 'skipped',
    wasEdited: true,
    createdAt: null,
  });
}

function makeBlankDraftLi() {
  const li = document.createElement('li');
  li.className = 'list-item draft';
  li.dataset.draftId = '';
  return li;
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
  $('prompt-picker').addEventListener('change', onPromptPicked);
  $('add-example').addEventListener('click', () => addFewShotRow());
  $('add-correction').addEventListener('click', addCorrection);
  $('add-topic').addEventListener('click', addTopic);
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