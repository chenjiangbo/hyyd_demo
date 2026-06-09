/**
 * 寰宇探针 Popup
 * 配置后端地址 + 员工 ID，展示连接状态
 */

const $ = (id: string) => document.getElementById(id)!;

// 后端 WS 地址有默认；员工 ID 不给默认，必须手工填，
// 否则数据可能错误归到默认员工名下。
async function getConfig(): Promise<{ backendWsUrl: string; employeeCode: string }> {
  const r = await chrome.storage.local.get(['backendWsUrl', 'employeeCode']);
  return {
    backendWsUrl: (r.backendWsUrl as string) || 'ws://47.95.14.233:9093/ws',
    employeeCode: ((r.employeeCode as string) || '').trim(),
  };
}

async function setConfig() {
  const backendWsUrl = ($('backend-ws-url') as HTMLInputElement).value.trim();
  const employeeCode = ($('employee-code') as HTMLInputElement).value.trim();
  if (!employeeCode) {
    alert('员工 ID 必填，请填写后再保存。\n（必须和 trayapp、移动端一致）');
    return;
  }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(employeeCode)) {
    alert('员工 ID 只能用英文字母 / 数字 / 横线 / 下划线，长度 1-32。');
    return;
  }
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
