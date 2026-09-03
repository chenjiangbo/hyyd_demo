export {};

/**
 * 寰宇探针 Popup
 * 配置后端地址并展示泰康账号与员工绑定状态。
 */

const $ = (id: string) => document.getElementById(id)!;
const FINGERPRINT_STORAGE_KEY = 'orderFingerprints';
const TRACKING_ANALYSIS_STORAGE_KEY = 'trackingPoolAnalysis';
const EDIT_PAGE_ANALYSIS_STORAGE_KEY = 'editPageAnalysis';

async function getConfig(): Promise<{ backendWsUrl: string; collectPaused: boolean }> {
  const r = await chrome.storage.local.get(['backendWsUrl', 'collectPaused']);
  return {
    backendWsUrl: (r.backendWsUrl as string) || 'ws://47.95.14.233:9093/ws',
    collectPaused: r.collectPaused !== false,
  };
}

async function setConfig() {
  const backendWsUrl = ($('backend-ws-url') as HTMLInputElement).value.trim();
  await chrome.storage.local.set({ backendWsUrl });
  await refreshStatus();
}

async function refreshStatus() {
  const cfg = await chrome.storage.local.get('collectPaused');
  renderCollectStatus(cfg.collectPaused !== false);

  // 后端连接状态：通过 background 查询
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
    const wsDot = $('ws-dot');
    const wsText = $('ws-text');
    const accountText = $('tk-account-text');
    if (chrome.runtime.lastError || !resp) {
      wsDot.className = 'dot dot-red';
      wsText.textContent = '未响应';
      accountText.textContent = '无法识别';
      return;
    }
    accountText.textContent = resp.taikangAccount
      ? `${resp.taikangNickName ? `${resp.taikangNickName}（${resp.taikangAccount}）` : resp.taikangAccount}`
      : '未识别';
    if (resp.wsConnected) {
      wsDot.className = 'dot dot-green';
      wsText.textContent = `已连接 ${resp.employeeName ?? ''}`;
    } else if (resp.connectionError) {
      wsDot.className = 'dot dot-red';
      wsText.textContent = resp.connectionError;
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

function renderCollectStatus(paused: boolean) {
  const collectDot = $('collect-dot');
  const collectText = $('collect-text');
  const toggleButton = $('toggle-collect') as HTMLButtonElement;
  if (paused) {
    collectDot.className = 'dot dot-amber';
    collectText.textContent = '已暂停';
    toggleButton.textContent = '恢复采集';
  } else {
    collectDot.className = 'dot dot-green';
    collectText.textContent = '运行中';
    toggleButton.textContent = '暂停采集';
  }
}

async function toggleCollectPaused() {
  const r = await chrome.storage.local.get('collectPaused');
  const current = r.collectPaused !== false;
  const next = !current;
  await chrome.storage.local.set({ collectPaused: next });
  renderCollectStatus(next);
}

async function clearLocalCache() {
  if (!confirm('确定清理本地订单指纹缓存？\n清理后后续采集可能重新拉取订单详情。')) return;

  await chrome.storage.local.remove(FINGERPRINT_STORAGE_KEY);

  const tabs = await chrome.tabs.query({ url: '*://ccm.taikang.com/*' });
  const tabIds = tabs.map((t) => t.id).filter((id): id is number => typeof id === 'number');
  await Promise.all(
    tabIds.map((tabId) => chrome.tabs.sendMessage(tabId, { type: 'CLEAR_LOCAL_CACHE' }))
  );

  alert(`本地缓存已清理。已通知 ${tabIds.length} 个泰康标签页。`);
}

async function getTaikangTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ url: '*://ccm.taikang.com/*' });
}

type TrackingPopupMode = 'all' | 'missing' | 'zh-register' | 'zh-green';

async function startTrackingAnalysis(mode: TrackingPopupMode = 'all') {
  const tabs = await getTaikangTabs();
  const tab = tabs.find((t) => t.active) ?? tabs[0];
  if (!tab?.id) {
    alert('没有找到已打开的泰康标签页。请先打开并登录泰康系统。');
    return;
  }
  await chrome.storage.local.set({
    [TRACKING_ANALYSIS_STORAGE_KEY]: {
      status: 'running',
      mode,
      updatedAt: new Date().toISOString(),
      progress: { serviceIndex: 0, serviceTotal: 0, sampleCount: 0 },
    },
  });
  const messageType =
    mode === 'missing'
      ? 'START_MISSING_TRACKING_POOL_ANALYSIS'
      : mode === 'zh-register'
        ? 'START_TRACKING_POOL_ZH_REGISTER'
        : mode === 'zh-green'
          ? 'START_TRACKING_POOL_ZH_GREEN'
          : 'START_TRACKING_POOL_ANALYSIS';
  await chrome.tabs.sendMessage(tab.id, { type: messageType });
  await refreshTrackingAnalysisStatus();
  const label =
    mode === 'missing'
      ? '缺失类型深挖'
      : mode === 'zh-register'
        ? '挂号追踪池中文梳理'
        : mode === 'zh-green'
          ? '绿通追踪池中文梳理'
          : '追踪池分析';
  alert(`${label}已开始。可以关闭 popup，稍后再打开点“状态”或“下载”。`);
}

function formatAnalysisStatus(state: any): string {
  if (!state) return '追踪池分析：暂无结果';
  const statusMap: Record<string, string> = {
    idle: '空闲',
    running: '运行中',
    done: '已完成',
    error: '失败',
  };
  const progress = state.progress || {};
  const parts = [
    `追踪池分析：${statusMap[state.status] || state.status || '未知'}`,
    `模式：${state.mode === 'missing' ? '缺失类型深挖' : state.mode === 'zh-register' ? '挂号中文梳理' : state.mode === 'zh-green' ? '绿通中文梳理' : '全量抽样'}`,
    `服务 ${progress.serviceIndex ?? 0}/${progress.serviceTotal ?? 0}`,
    `样本 ${progress.sampleCount ?? 0}`,
  ];
  if (progress.currentService) parts.push(`当前：${progress.currentService}`);
  if (state.error) parts.push(`错误：${state.error}`);
  if (state.updatedAt) parts.push(`更新：${new Date(state.updatedAt).toLocaleString()}`);
  return parts.join('；');
}

async function refreshTrackingAnalysisStatus() {
  const r = await chrome.storage.local.get(TRACKING_ANALYSIS_STORAGE_KEY);
  $('tracking-analysis-status').textContent = formatAnalysisStatus(r[TRACKING_ANALYSIS_STORAGE_KEY]);
}

async function downloadTrackingAnalysis() {
  const r = await chrome.storage.local.get(TRACKING_ANALYSIS_STORAGE_KEY);
  const state = r[TRACKING_ANALYSIS_STORAGE_KEY];
  if (!state?.result) {
    alert('还没有可下载的追踪池分析结果。');
    return;
  }
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `tracking-pool-analysis-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function clearTrackingAnalysis() {
  await chrome.storage.local.remove(TRACKING_ANALYSIS_STORAGE_KEY);
  await refreshTrackingAnalysisStatus();
}

async function sendToActiveTaikangTab(message: unknown) {
  const tabs = await getTaikangTabs();
  const tab = tabs.find((t) => t.active) ?? tabs[0];
  if (!tab?.id) {
    throw new Error('没有找到已打开的泰康标签页');
  }
  return chrome.tabs.sendMessage(tab.id, message);
}

function formatEditAnalysisStatus(state: any): string {
  if (!state) return '编辑页分析：暂无结果';
  const snapshots = Array.isArray(state.snapshots) ? state.snapshots.length : 0;
  const networkEvents = Array.isArray(state.networkEvents) ? state.networkEvents.length : 0;
  const automationEvents = Array.isArray(state.automationEvents) ? state.automationEvents.length : 0;
  const parts = [`编辑页分析：快照 ${snapshots}`, `接口 ${networkEvents}`, `自动动作 ${automationEvents}`];
  if (state.updatedAt) parts.push(`更新：${new Date(state.updatedAt).toLocaleString()}`);
  return parts.join('；');
}

async function refreshEditAnalysisStatus() {
  const r = await chrome.storage.local.get(EDIT_PAGE_ANALYSIS_STORAGE_KEY);
  $('edit-analysis-status').textContent = formatEditAnalysisStatus(r[EDIT_PAGE_ANALYSIS_STORAGE_KEY]);
}

async function startEditProbe() {
  await sendToActiveTaikangTab({ type: 'START_EDIT_PAGE_PROBE' });
  await refreshEditAnalysisStatus();
  alert('编辑页监听已开始。之后切换阶段/打开编辑页时，页面接口字段结构会被记录。');
}

async function scanEditPage() {
  const resp: any = await sendToActiveTaikangTab({ type: 'SCAN_EDIT_PAGE_FORM' });
  await refreshEditAnalysisStatus();
  if (!resp?.ok) {
    throw new Error(resp?.error || '扫描失败');
  }
  alert(`已扫描当前页，字段控件 ${resp.fieldCount ?? 0} 个。`);
}

async function startEditAutoTrial() {
  const resp: any = await sendToActiveTaikangTab({ type: 'START_EDIT_PAGE_AUTO_TRIAL' });
  await refreshEditAnalysisStatus();
  if (!resp?.ok) {
    throw new Error(resp?.error || '自动试跑失败');
  }
  alert(`自动试跑完成。${resp.message || ''} 当前快照 ${resp.snapshots ?? 0} 个。`);
}

type EditAutoEntryMode = 'register-personal' | 'green-personal' | 'case-service';

async function startEditAutoEntry(mode: EditAutoEntryMode) {
  const messageType =
    mode === 'register-personal'
      ? 'START_EDIT_AUTO_REGISTER_PERSONAL'
      : mode === 'green-personal'
        ? 'START_EDIT_AUTO_GREEN_PERSONAL'
        : 'START_EDIT_AUTO_CASE_SERVICE';
  const label =
    mode === 'register-personal'
      ? '挂号个人池'
      : mode === 'green-personal'
        ? '绿通个人池'
        : '个案服务待办';
  const resp: any = await sendToActiveTaikangTab({ type: messageType });
  await refreshEditAnalysisStatus();
  if (!resp?.ok) {
    throw new Error(resp?.error || `${label}梳理失败`);
  }
  alert(`${label}第一单梳理完成。${resp.message || ''} 当前快照 ${resp.snapshots ?? 0} 个。`);
}

async function startEditBatchEntry(mode: EditAutoEntryMode) {
  const messageType =
    mode === 'register-personal'
      ? 'START_EDIT_BATCH_REGISTER_PERSONAL'
      : mode === 'green-personal'
        ? 'START_EDIT_BATCH_GREEN_PERSONAL'
        : 'START_EDIT_BATCH_CASE_SERVICE';
  const label =
    mode === 'register-personal'
      ? '挂号个人池'
      : mode === 'green-personal'
        ? '绿通个人池'
        : '个案服务待办';
  const resp: any = await sendToActiveTaikangTab({ type: messageType });
  await refreshEditAnalysisStatus();
  if (!resp?.ok) {
    throw new Error(resp?.error || `${label}批量梳理失败`);
  }
  const serviceCounts = resp.serviceCounts ? JSON.stringify(resp.serviceCounts) : '';
  alert(`${label}批量梳理完成。${resp.message || ''} 当前快照 ${resp.snapshots ?? 0} 个。${serviceCounts}`);
}

async function downloadEditAnalysis() {
  const r = await chrome.storage.local.get(EDIT_PAGE_ANALYSIS_STORAGE_KEY);
  const state = r[EDIT_PAGE_ANALYSIS_STORAGE_KEY];
  if (!state || (!state.snapshots?.length && !state.networkEvents?.length)) {
    alert('还没有可下载的编辑页分析结果。');
    return;
  }
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `edit-page-analysis-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function clearEditAnalysis() {
  await chrome.storage.local.remove(EDIT_PAGE_ANALYSIS_STORAGE_KEY);
  await refreshEditAnalysisStatus();
}

(async function init() {
  const config = await getConfig();
  ($('backend-ws-url') as HTMLInputElement).value = config.backendWsUrl;
  renderCollectStatus(config.collectPaused);
  await refreshStatus();
  await refreshTrackingAnalysisStatus();
  await refreshEditAnalysisStatus();

  $('save-config').addEventListener('click', () => {
    setConfig().catch((e) => console.error(e));
  });

  $('toggle-collect').addEventListener('click', () => {
    toggleCollectPaused().catch((e) => {
      console.error(e);
      alert(`切换采集状态失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('clear-cache').addEventListener('click', () => {
    clearLocalCache().catch((e) => {
      console.error(e);
      alert(`清理本地缓存失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('start-tracking-analysis').addEventListener('click', () => {
    startTrackingAnalysis('all').catch((e) => {
      console.error(e);
      alert(`启动追踪池分析失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('start-missing-tracking-analysis').addEventListener('click', () => {
    startTrackingAnalysis('missing').catch((e) => {
      console.error(e);
      alert(`启动缺失类型深挖失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('start-tracking-zh-register').addEventListener('click', () => {
    startTrackingAnalysis('zh-register').catch((e) => {
      console.error(e);
      alert(`启动挂号追踪池中文梳理失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('start-tracking-zh-green').addEventListener('click', () => {
    startTrackingAnalysis('zh-green').catch((e) => {
      console.error(e);
      alert(`启动绿通追踪池中文梳理失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('refresh-tracking-analysis').addEventListener('click', () => {
    refreshTrackingAnalysisStatus().catch((e) => {
      console.error(e);
      alert(`刷新分析状态失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('download-tracking-analysis').addEventListener('click', () => {
    downloadTrackingAnalysis().catch((e) => {
      console.error(e);
      alert(`下载分析结果失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('clear-tracking-analysis').addEventListener('click', () => {
    clearTrackingAnalysis().catch((e) => {
      console.error(e);
      alert(`清除分析结果失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('start-edit-probe').addEventListener('click', () => {
    startEditProbe().catch((e) => {
      console.error(e);
      alert(`启动编辑页监听失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('scan-edit-page').addEventListener('click', () => {
    scanEditPage().catch((e) => {
      console.error(e);
      alert(`扫描当前编辑页失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('start-edit-auto-trial').addEventListener('click', () => {
    startEditAutoTrial().catch((e) => {
      console.error(e);
      alert(`编辑页自动试跑失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('start-edit-register-personal').addEventListener('click', () => {
    startEditAutoEntry('register-personal').catch((e) => {
      console.error(e);
      alert(`挂号个人池梳理失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('start-edit-green-personal').addEventListener('click', () => {
    startEditAutoEntry('green-personal').catch((e) => {
      console.error(e);
      alert(`绿通个人池梳理失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('start-edit-case-service').addEventListener('click', () => {
    startEditAutoEntry('case-service').catch((e) => {
      console.error(e);
      alert(`个案服务待办梳理失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('start-edit-batch-register-personal').addEventListener('click', () => {
    startEditBatchEntry('register-personal').catch((e) => {
      console.error(e);
      alert(`挂号个人池批量梳理失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('start-edit-batch-green-personal').addEventListener('click', () => {
    startEditBatchEntry('green-personal').catch((e) => {
      console.error(e);
      alert(`绿通个人池批量梳理失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('start-edit-batch-case-service').addEventListener('click', () => {
    startEditBatchEntry('case-service').catch((e) => {
      console.error(e);
      alert(`个案服务待办批量梳理失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('download-edit-analysis').addEventListener('click', () => {
    downloadEditAnalysis().catch((e) => {
      console.error(e);
      alert(`下载编辑页分析失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });

  $('clear-edit-analysis').addEventListener('click', () => {
    clearEditAnalysis().catch((e) => {
      console.error(e);
      alert(`清除编辑页分析失败：${e instanceof Error ? e.message : String(e)}`);
    });
  });
})();
