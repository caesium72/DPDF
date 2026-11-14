const on = document.getElementById('on');
const state = document.getElementById('state');

function render(enabled) {
  on.checked = enabled;
  state.textContent = enabled
    ? 'On — stays on until you turn it off.'
    : 'Off — PDFs open normally.';
}

chrome.storage.local.get({ enabled: true }, ({ enabled }) => render(enabled));

on.addEventListener('change', () => chrome.storage.local.set({ enabled: on.checked }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'enabled' in changes) render(changes.enabled.newValue);
});
