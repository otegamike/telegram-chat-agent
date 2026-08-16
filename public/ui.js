'use strict';

function busy(btn, on, busyText) {
  if (!btn) return;
  if (on) {
    btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
    btn.classList.add('loading');
    btn.disabled = true;
    if (busyText !== undefined) {
      btn.textContent = busyText;
    }
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
    if (btn.dataset.originalText !== undefined) {
      btn.textContent = btn.dataset.originalText;
    }
  }
}

function ensureToastContainer() {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

function toast(message, kind) {
  const container = ensureToastContainer();
  const el = document.createElement('div');
  el.className = `toast ${kind || 'success'}`;
  el.textContent = message;
  container.appendChild(el);
  el.offsetHeight;
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2600);
}