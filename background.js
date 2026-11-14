const RULE_ID = 1;
const VIEWER_URL = chrome.runtime.getURL('viewer.html');

const PDF_RULE = {
  id: RULE_ID,
  priority: 1,
  action: {
    type: 'redirect',
    redirect: { regexSubstitution: VIEWER_URL + '#\\1\\2' }
  },
  condition: {
    regexFilter: '^(https?://[^?#]*\\.[Pp][Dd][Ff])([?#][^#]*)?$',
    resourceTypes: ['main_frame']
  }
};

function isPdfUrl(u) {
  return /^(https?:\/\/|file:\/\/)[^?#]*\.[Pp][Dd][Ff]([?#][^#]*)?$/i.test(u);
}

async function getEnabled() {
  return (await chrome.storage.local.get({ enabled: true })).enabled;
}

async function applyRule() {
  const enabled = await getEnabled();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: enabled ? [PDF_RULE] : []
  });
}

function toViewer(url) {
  return VIEWER_URL + '#' + encodeURIComponent(url);
}

async function convertOpenPdfTabs() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    const u = t.pendingUrl || t.url || '';
    if (u && !u.startsWith(VIEWER_URL) && isPdfUrl(u)) {
      chrome.tabs.update(t.id, { url: toViewer(u) });
    }
  }
}

async function restoreViewerTabs() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    const u = t.pendingUrl || t.url || '';
    if (u.startsWith(VIEWER_URL) && t.id != null) {
      try {
        const res = await chrome.tabs.sendMessage(t.id, { type: 'dpdf-get-source' });
        if (res && res.url) chrome.tabs.update(t.id, { url: res.url });
      } catch (e) {}
    }
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('enabled' in changes)) return;
  applyRule()
    .then(() => (changes.enabled.newValue ? convertOpenPdfTabs() : restoreViewerTabs()))
    .catch(() => {});
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameType !== 'outermost_frame' || !details.url.startsWith('file://')) return;
  getEnabled().then((enabled) => {
    if (enabled && isPdfUrl(details.url)) {
      chrome.tabs.update(details.tabId, { url: toViewer(details.url) });
    }
  });
});

chrome.runtime.onInstalled.addListener(applyRule);
chrome.runtime.onStartup.addListener(applyRule);
applyRule();
