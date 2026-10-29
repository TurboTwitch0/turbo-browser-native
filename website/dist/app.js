'use strict';

const menuToggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#site-nav');
menuToggle.addEventListener('click', () => {
  const open = menuToggle.getAttribute('aria-expanded') !== 'true';
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  navigation.classList.toggle('open', open);
});
navigation.addEventListener('click', event => {
  if (!event.target.closest('a')) return;
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', 'Open navigation');
  navigation.classList.remove('open');
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navigation.classList.contains('open')) {
    menuToggle.click();
    menuToggle.focus();
  }
});

const installTabs = Array.from(document.querySelectorAll('.install-tabs [role="tab"]'));
function selectTab(selected) {
  installTabs.forEach(tab => {
    const active = selected === tab;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
  });
  document.querySelector('#copy-status').textContent = '';
}
installTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = installTabs[(index + 1) % installTabs.length];
    if (event.key === 'ArrowLeft') next = installTabs[(index - 1 + installTabs.length) % installTabs.length];
    if (event.key === 'Home') next = installTabs[0];
    if (event.key === 'End') next = installTabs[installTabs.length - 1];
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    next.focus();
  });
});

document.querySelector('#copy-code').addEventListener('click', async () => {
  const status = document.querySelector('#copy-status');
  const code = document.querySelector('#install-code');
  try {
    await navigator.clipboard.writeText(code.textContent);
    status.textContent = 'Commands copied. Paste them into your terminal.';
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = 'Commands selected. Press Ctrl+C to copy them.';
  }
});
