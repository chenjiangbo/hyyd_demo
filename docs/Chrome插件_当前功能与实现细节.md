# Chrome 插件当前功能与实现细节

本文记录 `packages/extension` 当前 Chrome 插件的功能、数据流和关键实现约束，作为后续调整“真的绿通”订单采集逻辑前的现状基线。

## 1. 插件定位

插件名为“寰宇医道 - 泰康助手探针”，用于连接泰康系统 `ccm.taikang.com` 与寰宇医道后端中枢。

当前插件是只读自动采集模式：

- 不解析泰康页面 DOM。
- 不点击、不申领、不填写、不执行后端 command。
- 在泰康页面内通过接口直采订单列表、订单详情和附件。
- 通过 WebSocket 把采集结果上报给后端。
- 后端负责订单 upsert、状态历史、详情入库、附件入 MinIO、指纹基线下发。

## 2. 代码入口

| 文件 | 作用 |
|---|---|
| `packages/extension/public/manifest.json` | MV3 插件声明、权限、content script 注入规则、自动更新地址 |
| `packages/extension/src/background/index.ts` | Service Worker，维护后端 WebSocket、转发 content/popup 消息、presence 心跳 |
| `packages/extension/src/content/index.ts` | 注入泰康页面，执行泰康接口直采、增量详情采集、登录态检测 |
| `packages/extension/src/popup/index.ts` | 插件弹窗逻辑，配置后端 WS、员工 ID、暂停/恢复采集、清理本地缓存 |
| `packages/extension/src/popup/index.html` | 插件弹窗 UI |
| `packages/extension/tsup.config.ts` | 构建配置，输出 iife 到 `dist`，复制 manifest 和 popup HTML |
| `scripts/pack-extension.js` | 打包 `.crx` 并生成 `update.xml` |

## 3. Manifest 与权限

当前 manifest 版本为 `1.2.1`。

关键配置：

- `manifest_version: 3`
- `host_permissions: *://ccm.taikang.com/*`
- 权限：`storage`、`activeTab`、`tabs`、`alarms`
- background：`background.global.js`
- content script：
  - 匹配 `*://ccm.taikang.com/*`
  - `run_at: document_end`
  - `all_frames: false`
- popup：`popup.html`
- 自动更新地址：`http://47.95.14.233:9093/ext/update.xml`

插件固定 ID 由 manifest 的 `key` 和本地签名私钥派生。分发和更新详见 `docs/插件分发与部署说明.md`。

## 4. 配置与状态

插件使用 `chrome.storage.local` 保存以下关键数据：

| Key | 含义 |
|---|---|
| `backendWsUrl` | 后端 WebSocket 地址，默认 `ws://47.95.14.233:9093/ws` |
| `employeeCode` | 员工 ID，必须人工配置；没有默认值 |
| `collectPaused` | 是否暂停采集 |
| `orderFingerprints` | 本地订单状态指纹缓存 |

重要约束：

- `employeeCode` 未配置时，background 不连接 WebSocket。
- popup 保存配置时强校验 `employeeCode`，只允许英文字母、数字、横线、下划线，长度 1-32。
- 后端 WS 地址有默认值；员工 ID 没有默认值，避免数据归错员工。
- 暂停采集只影响 content script 的轮询和详情抓取，不会清除缓存。

## 5. Background Service Worker

`background/index.ts` 负责后端连接和消息中转。

### 5.1 WebSocket 连接

连接地址格式：

```text
{backendWsUrl}?employeeCode={employeeCode}&client=ext
```

连接成功后：

- 清理重连定时器。
- 立即发送一次 presence。
- 每 10 秒发送一次 presence。
- 收到 `connection_established` 后缓存后端返回的员工姓名，并主动请求订单指纹基线。

断开后：

- 清理 presence 定时器。
- 5 秒后重连。

### 5.2 MV3 保活

Chrome MV3 Service Worker 可能空闲休眠。插件通过 `chrome.alarms` 每 15 秒触发一次：

- 如果 WS 关闭，尝试重连。
- 如果 WS 已连接，发送 `{ type: "ping" }`。

### 5.3 Presence 心跳

presence 内容：

```ts
{
  type: 'PRESENCE',
  taikangTabOpen: boolean,
  trackingPoolPageActive: boolean,
  ts: number
}
```

其中：

- `taikangTabOpen` 表示是否存在 `ccm.taikang.com` 标签页。
- `trackingPoolPageActive` 表示是否存在 URL 包含 `/register/register` 的泰康挂号协助待办页。

### 5.4 消息转发

background 接收 content/popup 消息后转发给后端：

| content/popup 消息 | 后端 WS 消息 | 说明 |
|---|---|---|
| `SYNC_ORDERS` | `ORDERS_SYNCED` | 上报列表订单 |
| `ORDER_DETAIL_FETCHED` | `ORDER_DETAIL_FETCHED` | 上报订单详情、附件或详情抓取错误 |
| `TAIKANG_TOKEN_STATUS` | `TAIKANG_TOKEN_STATUS` | 上报泰康登录态检测结果 |
| `SYNC_FINGERPRINTS` | `SYNC_FINGERPRINTS` | 上报本地全量订单指纹给后端对账 |
| `REQUEST_FINGERPRINT_BASELINE` | `GET_FINGERPRINTS` | 请求后端下发指纹基线 |
| `GET_STATUS` | 不转发 | popup 查询本地状态 |

后端返回 `FINGERPRINTS_BASELINE` 时，background 会转发给所有 `ccm.taikang.com` 标签页的 content script。

## 6. Content Script 采集逻辑

`content/index.ts` 注入泰康页面后，所有泰康接口请求都从页面上下文发起，自动携带泰康 cookie。

### 6.1 泰康接口域名

```ts
const UNIFY_BASE = 'https://ccm.taikang.com/ccm-unify/ccm-unify/ccm-unify';
const SYSTEM_BASE = 'https://ccm.taikang.com/ccm-unify/hssrmp';
```

### 6.2 Token 读取

泰康接口使用 header `access_token` 认证。插件按以下顺序读取 token：

1. Cookie：`Admin-Token`
2. Cookie：`access_token`
3. Cookie：`token`
4. `localStorage/sessionStorage`：`access_token`
5. `localStorage/sessionStorage`：`token`
6. `localStorage/sessionStorage`：`Admin-Token`
7. `localStorage/sessionStorage`：`accessToken`
8. `localStorage/sessionStorage`：`Authorization`

读取到 token 时，请求会添加 `access_token` header。请求同时设置 `credentials: 'include'`。

### 6.3 鉴权失败判定

泰康鉴权失败时可能 HTTP 仍为 200，因此插件主要按业务响应码判断。

`code` 在 `401100` 到 `401199` 之间时抛出 `TaikangAuthError`。HTTP `401` 或 `302` 也会被视作鉴权错误。

普通接口失败会抛错；部分子接口通过 `safe()` 包裹，非鉴权错误只记录警告并返回 `null`。

### 6.4 轮询节奏

当前轮询参数：

| 参数 | 值 | 含义 |
|---|---:|---|
| `POLL_FIRST_DELAY_MS` | 3000 | 首次延迟 3 秒 |
| `POLL_INTERVAL_MS` | 120000 | 每 2 分钟一轮 |
| `DETAIL_THROTTLE_MS` | 3000 | 相邻订单详情抓取间隔 3 秒 |
| `PAGE_SIZE` | 20 | 泰康列表接口分页大小 |
| `MAX_PAGES` | 50 | 单个池最多翻 50 页 |

启动流程：

1. 读取本地 `orderFingerprints`。
2. 向后端请求指纹基线。
3. 收到后端基线后合并到本地缓存并开始轮询。
4. 如果 5 秒内没有收到后端基线，也会开始轮询。

注意：这里存在一个 5 秒兜底启动逻辑。若后端基线没有及时返回，本地缓存为空时可能会触发更多详情抓取。

## 7. 订单池采集范围

插件同时采集个人池和公共池。

### 7.1 个人池

个人池代表已申领到当前泰康账号的订单，会采列表并按增量抓详情。

插件先调用 `system/user/getInfo` 获取：

- `userid`
- `username`
- `nickName`

然后并发拉两套个人池：

| 业务类型 | 接口 | 入参 |
|---|---|---|
| 挂号协助 | `medicalmanager/registerIndividualPool` | `{ userId, serviceType: '2000709' }` |
| 其他绿通业务 | `medicalmanager/individualPool` | `{ userId, userName }` |

合并规则：

- 按 `subOrderNo` 去重。
- `register` 后写入，覆盖 `general`，即同号时挂号协助优先。
- 每条订单标记 `__pool = 'personal'`。
- 每条订单标记 `__poolType = 'register' | 'general'`。

### 7.2 公共池

公共池代表待申领订单，只采列表，不抓详情。

并发拉两套公共池：

| 业务类型 | 接口 | 入参 |
|---|---|---|
| 挂号协助 | `medicalmanager/registerWaitingPool` | `{ provider: '3', serviceType: '2000709' }` |
| 其他绿通业务 | `medicalmanager/waitingPool` | `{ provider: '3', userName }` |

合并规则：

- 按 `subOrderNo` 去重。
- `register` 覆盖 `general`。
- 每条订单标记 `__pool = 'public'`。
- 每条订单标记 `__poolType = 'register' | 'general'`。

公共池采集失败时，非鉴权错误会被记录警告，并忽略本轮公共池；个人池主流程继续。

## 8. 列表上报字段

列表项通过 `toReportedOrder()` 转成后端结构。

核心字段：

| 字段 | 来源/含义 |
|---|---|
| `sourceOrderNo` | `subOrderNo` |
| `orderId` | `subOrderNo`，兼容旧后端字段 |
| `pool` | `personal` 或 `public` |
| `poolType` | `register` 或 `general` |
| `applyNo` | 泰康 `applyNo` |
| `crmApplyNo` | 泰康 `crmApplyNo` |
| `caseId` | 泰康 `caseId` |
| `taikangOrderState` | `orderState` 字符串 |
| `taikangOrderStateName` | `orderStateName` 字符串 |
| `taikangCaseStatus` | `caseStatus` 字符串 |
| `taikangWaitType` | `waitType` 字符串 |
| `taikangServState` | `servState` 字符串 |
| `status` | 兼容字段，等于 `taikangOrderStateName` |
| `orderState` | 兼容字段，等于 `taikangOrderState` |
| `caseStatus` | 兼容字段，等于 `taikangCaseStatus` |
| `serviceType` | `serviceName || itemName` |
| `patientName` | 就诊人 |
| `insurName` | 被保人 |
| `sex` | 性别 |
| `paMobile` | 多个手机号字段按顺序取值，取不到为 `null` |
| `hospital` | `intendHos || clinicHos || null` |
| `dept` | `intendDept || clinicDept || null` |
| `doctor` | `intendDoc || null` |
| `networkTag` | `labelName` |
| `planName` / `planAlias` / `packetName` / `productName` / `itemName` | 泰康列表原字段 |
| `applyTime` | `applyDate || applicationDate || null` |
| `applicationDate` | 泰康原字段 |
| `mmgrApplyDate` | 泰康原字段 |
| `taikangRawJson` / `rawJson` | 原始列表项 |

列表上报给后端的消息类型为 `ORDERS_SYNCED`。

## 9. 详情采集

详情只针对个人池订单执行，公共池不抓详情。

增量判断：

```ts
fingerprint = [orderState, orderStateName, caseStatus].join('|')
```

如果本地指纹与当前列表项指纹不同，则认为该订单需要重新抓详情。只有详情抓取成功后才更新本地指纹。

详情接口：

```text
medicalmanager/recommendations
```

入参：

```ts
{
  userId,
  subOrderNo,
  applyNo,
  orderState: order.orderState == null ? '' : String(order.orderState),
  caseStatus: order.caseStatus == null ? 'null' : String(order.caseStatus)
}
```

返回数据要求：

- `recResp.data` 必须存在。
- 如果为空，抛出 `EMPTY_DETAIL: recommendations 未返回详情数据`。

详情上报结构：

```ts
{
  sourceOrderNo,
  detail: { recommendations: rec },
  attachments,
  fingerprint
}
```

详情上报给后端的消息类型为 `ORDER_DETAIL_FETCHED`。

## 10. 附件采集

详情抓取成功后，插件会并发调用 `ecm/getImage` 获取附件。

当前附件类型：

```ts
['40', '41', '5000', '5001', '5002', '100', '99', '5010', '5008', '5009']
```

每个 fileType 请求：

```ts
{
  subOrderNo,
  fileType,
  pageNum: 1,
  pageSize: 5
}
```

附件保留条件：

- `fileUrl` 存在。
- `fileId` 存在。

上报字段：

| 字段 | 含义 |
|---|---|
| `fileType` | 附件类型 |
| `fileId` | 泰康文件 ID |
| `fileName` | 泰康文件名，缺省为 `{fileId}.{fileDataType || 'jpg'}` |
| `mimeType` | `image/{fileDataType || 'jpeg'}` |
| `base64` | 泰康 `fileUrl`，实际为 base64 |
| `rawJson` | 去掉 `fileUrl` 后的附件元数据 |

附件子接口用 `safe()` 包裹，非鉴权错误不阻塞详情主流程。

## 11. 本地指纹与后端基线

本地缓存：

- Key：`orderFingerprints`
- 内容：`{ [sourceOrderNo]: fingerprint }`
- 保存位置：`chrome.storage.local`

抓详情时：

- 串行处理 changed 订单。
- 每成功 10 条详情落盘一次指纹。
- 本轮结束后再补保存一次。
- 详情失败不更新指纹，下轮继续重试。

与后端对账：

- content script 每轮结束调用 `SYNC_FINGERPRINTS`，把本地全量指纹推给后端。
- background 在连接建立后调用 `GET_FINGERPRINTS`。
- 后端返回 `FINGERPRINTS_BASELINE` 后，content script 只补充本地不存在的指纹，不覆盖本地已有指纹。
- 合并基线后会保存到本地，并反向把本地全量指纹推给后端。

popup 的“清理本地缓存”会：

1. 删除 `chrome.storage.local.orderFingerprints`。
2. 向所有泰康标签页发送 `CLEAR_LOCAL_CACHE`。
3. content script 清空内存 Map 并删除本地缓存。

## 12. 登录态处理

登录态只以个人池采集成功作为全局有效判断。

流程：

- 个人池能拉到：调用 `onAuthOk()`。
- 个人池或用户信息接口抛出 `TaikangAuthError`：调用 `onAuthFail()`。
- 公共池非鉴权失败不会影响全局登录态。
- 详情阶段的鉴权失败只中断本轮剩余详情，不直接报全局过期。

当前过期判定：

- `AUTH_FAIL_THRESHOLD = 2`
- 第一次鉴权失败后，30 秒快速重试一次。
- 连续 2 次失败才认为登录态失效。

确认失效后：

- 清空缓存的泰康用户信息。
- 在泰康页面顶部注入红色提示条。
- 上报 `TAIKANG_TOKEN_STATUS`，`ok: false`。

恢复成功后：

- 移除提示条。
- 上报 `TAIKANG_TOKEN_STATUS`，`ok: true`。

## 13. Popup 功能

popup 提供以下功能：

- 展示后端连接状态。
- 展示泰康标签页是否打开。
- 展示采集状态。
- 配置后端 WS 地址。
- 配置员工 ID。
- 暂停/恢复采集。
- 清理本地订单指纹缓存。

后端连接状态通过向 background 发送 `GET_STATUS` 获取。

泰康标签状态通过 `chrome.tabs.query({ url: '*://ccm.taikang.com/*' })` 判断。

## 14. 后端接收处理

后端 WS 入口在 `packages/backend/src/index.ts`。

### 14.1 连接建立

后端根据 `employeeCode` 找员工，连接成功后返回：

```ts
{
  type: 'connection_established',
  client,
  employee: { id, name }
}
```

### 14.2 `ORDERS_SYNCED`

后端对每条订单执行 upsert：

- 唯一键：`source='taikang' + sourceOrderNo=orderData.orderId`
- `customerName` 来自 `patientName`，缺省为 `未知`
- `status` 使用 `taikangOrderStateName`
- `orderState` 使用 `taikangOrderState`
- `rawJson` 保存列表上报结构和泰康状态字段

归属规则：

- `pool = personal`：`assignedEmployeeId = 当前 employeeId`
- `pool = public`：
  - create 时 `assignedEmployeeId = null`
  - update 时当前代码也写 `assignedEmployeeId = null`

状态历史：

- 首次出现或 `orderState` 变化时，写 `OrderStatusHistory`。

### 14.3 `ORDER_DETAIL_FETCHED`

如果 payload 有 `error`：

- 后端记录 warning。
- 若 tray 连接在线，发送 `ORDER_DETAIL_ERROR`。

如果 payload 正常：

- 调用 `saveOrderDetailBundle()`。
- 更新 `Order.detailJson`。
- 更新 `Order.detailFetchedAt`。
- 如果 payload 带 `fingerprint`，更新 `Order.detailFingerprint`。
- base64 附件写入 MinIO bucket `order-attachments`。
- `OrderAttachment` 按 `[orderId, fileId]` upsert。
- 若 tray 连接在线，发送 `ORDER_DETAIL_READY`。

### 14.4 `SYNC_FINGERPRINTS`

后端按当前员工名下订单补齐 `detailFingerprint`：

- 条件：`source='taikang'`
- 条件：`sourceOrderNo` 匹配
- 条件：`assignedEmployeeId = 当前 employeeId`

### 14.5 `GET_FINGERPRINTS`

后端查询当前员工名下、已保存 `detailFingerprint` 的订单，返回：

```ts
{
  type: 'FINGERPRINTS_BASELINE',
  payload: { [sourceOrderNo]: detailFingerprint }
}
```

## 15. 当前实现中的重要注意点

1. 核心采集入口依赖泰康接口响应。`recommendations` 没有返回详情数据会明确报错，不会写空详情。
2. 公共池当前只上报列表，不抓详情。
3. 个人池详情采集以状态指纹增量触发，指纹只包含 `orderState`、`orderStateName`、`caseStatus`。
4. `safe()` 仅用于附件等子接口，避免单个附件类型失败影响整张订单详情上报；鉴权错误仍会向上抛。
5. content script 启动有 5 秒等待后端基线的兜底逻辑，本地无缓存且后端基线未到时可能增加泰康详情访问量。
6. 后端 `ORDERS_SYNCED` 对公共池 update 当前会写 `assignedEmployeeId: null`，代码注释说“不动 assignedEmployeeId”，但实际实现会置空。这一点如果影响申领后归属，需要后续单独确认后再改。
7. 插件已不消费后端 command，`Command` 表和旧命令入口仅历史兼容。
8. `poolType = general` 覆盖除挂号协助外的其他绿通业务，不再按具体服务类型分支调用详情辅助接口。

## 16. 构建与发布

开发构建：

```bash
pnpm --filter @hyyd/extension build
```

打包发布：

```bash
node scripts/pack-extension.js
cp packages/extension/release/{huanyu-extension.crx,update.xml} packages/backend/public/ext/
```

发布前必须递增 `packages/extension/public/manifest.json` 的 `version`，否则 Chrome 不会自动更新。
