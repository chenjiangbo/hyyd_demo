/**
 * 寰宇探针 Popup
 * 切换 pool_reader / worker 模式，展示连接状态
 */

type Mode = 'pool_reader' | 'worker';

const $ = (id: string) => document.getElementById(id)!;

async function getMode(): Promise<Mode> {
  const r = await chrome.storage.local.get('mode');
  return (r.mode as Mode) ?? 'worker';
}

async function setMode(mode: Mode) {
  await chrome.storage.local.set({ mode });
  // 通知 background 重新评估行为
  chrome.runtime.sendMessage({ type: 'MODE_CHANGED', mode });
}

function renderMode(mode: Mode) {
  const checkbox = $('pool-reader-checkbox') as HTMLInputElement;
  const badge = $('mode-badge');
  const warning = $('reader-warning');

  checkbox.checked = mode === 'pool_reader';
  if (mode === 'pool_reader') {
    badge.textContent = 'Pool Reader 模式';
    badge.className = 'mode-badge mode-badge-reader';
    warning.style.display = 'block';
  } else {
    badge.textContent = 'Worker 模式';
    badge.className = 'mode-badge mode-badge-worker';
    warning.style.display = 'none';
  }
}

async function refreshStatus() {
  // 后端连接状态：通过 background 查询
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
    const wsDot = $('ws-dot');
    const wsText = $('ws-text');
    if (chrome.runtime.lastError || !resp) {
      wsDot.className = 'dot dot-red';
      wsText.textContent = '未响应';
      return;
    }
    if (resp.wsConnected) {
      wsDot.className = 'dot dot-green';
      wsText.textContent = `已连接 ${resp.employeeName ?? ''}`;
    } else {
      wsDot.className = 'dot dot-red';
      wsText.textContent = '未连接';
    }
  });

  // 泰康标签状态
  const tabs = await chrome.tabs.query({ url: '*://ccm.taikang.com/*' });
  const tkDot = $('tk-dot');
  const tkText = $('tk-text');
  if (tabs.length > 0) {
    tkDot.className = 'dot dot-green';
    tkText.textContent = `已打开 (${tabs.length} 个)`;
  } else {
    tkDot.className = 'dot dot-red';
    tkText.textContent = '未打开';
  }
}

(async function init() {
  const mode = await getMode();
  renderMode(mode);
  await refreshStatus();

  $('pool-reader-checkbox').addEventListener('change', async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    const newMode: Mode = checked ? 'pool_reader' : 'worker';
    await setMode(newMode);
    renderMode(newMode);
  });
})();
