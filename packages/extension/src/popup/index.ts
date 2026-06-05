/**
 * 寰宇探针 Popup
 * 配置后端地址 + 员工 ID，展示连接状态
 */

const $ = (id: string) => document.getElementById(id)!;

async function getConfig(): Promise<{ backendWsUrl: string; employeeCode: string }> {
  const r = await chrome.storage.local.get(['backendWsUrl', 'employeeCode']);
  return {
    backendWsUrl: (r.backendWsUrl as string) || 'ws://192.168.202.1:13000/ws',
    employeeCode: (r.employeeCode as string) || 'huanyu-field-1',
  };
}

async function setConfig() {
  const backendWsUrl = ($('backend-ws-url') as HTMLInputElement).value.trim();
  const employeeCode = ($('employee-code') as HTMLInputElement).value.trim();
  await chrome.storage.local.set({ backendWsUrl, employeeCode });
  await refreshStatus();
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
      wsText.textContent = `已连接 ${resp.employeeName ?? resp.employeeCode ?? ''}`;
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
  const config = await getConfig();
  ($('backend-ws-url') as HTMLInputElement).value = config.backendWsUrl;
  ($('employee-code') as HTMLInputElement).value = config.employeeCode;
  await refreshStatus();

  $('save-config').addEventListener('click', () => {
    setConfig().catch((e) => console.error(e));
  });
})();
