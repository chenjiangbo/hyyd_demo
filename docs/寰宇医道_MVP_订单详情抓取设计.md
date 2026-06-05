# 订单详情抓取功能设计文档

> **状态**：草案 v0.1，待用户 review 确认  
> **关联**：[多员工协作设计](./寰宇医道_MVP_多员工协作设计.md) / [技术设计](./寰宇医道_MVP_技术设计.md)  
> **日期**：2026-05-27

## 1. 背景

当前申领台 [`IntakeView.tsx`](../packages/tray-app/src/renderer/src/pages/IntakeView.tsx) 在员工"申领"后会弹出 [`OrderDetailModal`](../packages/tray-app/src/renderer/src/components/OrderDetailModal.tsx)，但展示的数据其实来自**列表行**（`Order.rawJson`），并非泰康"订单详情页"独有的信息。详情页里的就诊人完整资料、身份证图片、保单条款等**目前完全没有采集**。

通过对详情页 [`debug/ccm.taikang.com.har`](../debug/ccm.taikang.com.har) 的抓包分析，我们已确认：

- 详情页是 SPA，打开时由前端调用 **6 个 XHR 接口**拿数据
- 所有接口入参只依赖一个明文 `subOrderNo`（= 我们列表 `rawJson.orderId`），无需解密 URL 上的加密串
- 未发现签名 / 防重放头，只用标准登录 cookie

因此可采用**方案 A：插件后台直接调 API**（不打开详情页 UI）。

## 2. 目标 / 非目标

### 目标

1. 申领成功后，插件在后台静默拉取该订单的"详情数据 + 证件图片"，回传后端入库
2. 托盘端弹窗 [`OrderDetailModal`](../packages/tray-app/src/renderer/src/components/OrderDetailModal.tsx) 展示**完整详情**（含图片缩略图，点击放大）
3. 详情数据可二次访问（不必每次重新抓），但允许员工"刷新详情"

### 非目标（本次不做）

- 不做"未申领就预取详情"（避免触发风控 + 数据归属不清）
- 不做图片 OCR / 身份证号自动识别
- 不做详情数据的反向编辑回写到泰康

## 3. 详情接口清单（来自 HAR）

全部为 `POST https://ccm.taikang.com/ccm-unify/ccm-unify/ccm-unify/{path}`，Body 为 JSON。

| # | path | 入参 | 用途 | 备注 |
|---|---|---|---|---|
| 1 | `medicalmanager/caseInfo` | `{subOrderNo}` | **主接口**，~150 字段 | 必拉，返回 `caseId / hospitalId` 供后续使用 |
| 2 | `register/getIntendClinicInfo` | `{caseId}` | 意向就诊信息 | 必拉 |
| 3 | `register/getLatestRegisterInfo` | `{subOrderNo}` | 最新挂号信息 | 必拉，返回 `hospitalId` 兜底 |
| 4 | `api/hospitalAddr` | `{hospitalId, supplierId, hospitalName}` | 医院候选地址 | 仅当上一步返回 hospitalId 时拉 |
| 5 | `register/ExceInfo` | `{subOrderNo}` | 异常信息 | 必拉 |
| 6 | `ecm/getImage` ×N | `{subOrderNo, fileType, pageNum:1, pageSize:5}` | 图片列表 | 按 `fileType` 枚举：`40/41/5000/5001/...` |

### 3.1 调用顺序与依赖

```
caseInfo  ─┬─► caseId  ──► getIntendClinicInfo
           ├─► hospitalId─► hospitalAddr (有 hospitalId 才调)
           └─► subOrderNo ──► getLatestRegisterInfo
                                ExceInfo
                                getImage ×N
```

并行策略：caseInfo 必须先调（为了拿 caseId/hospitalId 兜底）；其余 5 个可并行。

### 3.2 fileType 含义对照

HAR 中观察到 4 种：`40`、`41`、`5000`(空)、`5001`。语义需要业务确认，**MVP 阶段先按编号存**，后续补一张 `fileTypeName` 字典。建议枚举的 fileType 列表：`["40","41","5000","5001"]`，每个都调一次，空列表跳过。

## 4. 数据模型变更

### 4.1 `Order` 表

新增两个字段：

```prisma
model Order {
  // ... 现有字段
  detailJson        Json?     @map("detail_json")        // caseInfo + 4 个辅助接口的合并结果
  detailFetchedAt   DateTime? @map("detail_fetched_at")  // 最近一次抓取成功时间
}
```

`detailJson` 内部结构（约定，前端按这套读）：

```json
{
  "caseInfo":              { /* /medicalmanager/caseInfo 的 data */ },
  "intendClinicInfo":      { /* /register/getIntendClinicInfo 的 data */ },
  "latestRegisterInfo":    { /* /register/getLatestRegisterInfo 的 data */ },
  "hospitalAddr":          { /* /api/hospitalAddr 的 data，可能为 null */ },
  "exceInfo":              [ /* /register/ExceInfo 的 data */ ]
}
```

### 4.2 新表 `OrderAttachment`

```prisma
model OrderAttachment {
  id          Int      @id @default(autoincrement())
  orderId     Int      @map("order_id")
  order       Order    @relation(fields: [orderId], references: [id])
  fileType    String   @map("file_type")      // 泰康原始 fileType: "40" / "41" / ...
  fileId      String   @map("file_id")        // 泰康 fileId，用于去重
  fileName    String   @map("file_name")
  mimeType    String   @map("mime_type")      // 例如 "image/jpeg"
  minioBucket String   @map("minio_bucket")   // "order-attachments"
  minioKey    String   @map("minio_key")      // 例如 "orders/18/40/1361817.jpg"
  byteSize    Int      @map("byte_size")
  rawJson     Json?    @map("raw_json")       // ecm/getImage 返回的整条记录（去掉 fileUrl）
  createdAt   DateTime @default(now()) @map("created_at")

  @@unique([orderId, fileId])
  @@index([orderId])
  @@map("order_attachments")
}
```

Relation 在 `Order` 上加：`attachments OrderAttachment[]`。

### 4.3 MinIO 桶

新增桶 `order-attachments`，启动时确保存在（沿用 `index.ts` 已有的 MinIO 客户端 [`packages/backend/src/index.ts:19`](../packages/backend/src/index.ts:19)）。

## 5. 抓取触发与通信协议

### 5.1 现有流程回顾

申领 → 后端写 `Command{ action: "claim", ... }` → 通过 WS 推给插件 → 插件点击列表"详情"按钮（**就这里要改**）。

### 5.2 新流程

申领指令保留语义，但 payload 增加要求"附带详情"标志。两种实现，二选一：

**选项 1（推荐）**：**复用 `claim` 指令**，插件在执行 `claim` 后自动跟进抓详情，不需要后端发第二条指令。

**选项 2**：拆成两条指令 `claim` + `fetch_detail`。

> 推荐选项 1：耦合在一起逻辑更简单，失败原因也好定位（一条指令对应一次完整业务）。如果将来要"只抓详情不申领"，再拆。

### 5.3 插件 → 后端：上报详情

新增一种 WS 消息类型（沿用现有 [`index.ts:107` 的 onmessage 分发](../packages/backend/src/index.ts:107)）：

```ts
// 插件 → 后端
{
  type: "ORDER_DETAIL_FETCHED",
  payload: {
    sourceOrderNo: "COD60d48c8dd7ac57f6",
    detail: {
      caseInfo: { ... },
      intendClinicInfo: { ... },
      latestRegisterInfo: { ... },
      hospitalAddr: { ... } | null,
      exceInfo: [ ... ]
    },
    attachments: [
      {
        fileType: "40",
        fileId: "1361817",
        fileName: "...001.jpg",
        mimeType: "image/jpeg",
        base64: "/9j/4AAQ..."   // 直接传 base64
      }
    ]
  }
}
```

**为什么 base64 走 WS 而不是 HTTP 上传**：单条详情图片最大约 1.2MB，base64 后约 1.6MB，WS 单帧默认 100MB 上限足够；走 HTTP 还要额外做认证/分片，复杂度不值得。

后端收到后：
1. 把 `detail` 合并写入 `Order.detailJson` + `detailFetchedAt`
2. 把 `attachments[]` 逐个 base64 解码 → 上传 MinIO → 写 `OrderAttachment` 表（按 `[orderId, fileId]` upsert，去重）

### 5.4 后端 → 托盘：详情就绪通知

申领时 WS 推送 `CLAIMED` 给托盘已有；新增 `DETAIL_READY`：

```ts
// 后端 → 托盘
{
  type: "ORDER_DETAIL_READY",
  payload: { orderId: 18 }
}
```

托盘收到后自动 `GET /api/orders/:id/detail` 拉详情数据填到打开着的弹窗（如果用户已经关掉弹窗，就忽略）。

## 6. 新增 REST 接口

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/orders/:id/detail` | 返回 `{ order, detail: detailJson, attachments: [{id,fileType,fileName,url}] }`。`url` 是 MinIO presigned URL，有效期 1h |
| POST | `/api/orders/:id/refresh-detail` | 手动触发重抓（生成 `claim` 指令的"仅 fetch" 变种推给当前申领者的插件） |

注：附件图片不直接走后端代理，统一用 MinIO presigned URL，前端 `<img>` 直接拉，省后端带宽。

## 7. 插件改造（Chrome Extension）

### 7.1 新增模块：`detailFetcher.ts`

伪代码：

```ts
async function fetchOrderDetail(subOrderNo: string): Promise<DetailBundle> {
  const headers = { 'Content-Type': 'application/json' /* cookie 自带 */ };
  const post = (path, body) => fetch(`https://ccm.taikang.com/ccm-unify/ccm-unify/ccm-unify/${path}`, {
    method: 'POST', credentials: 'include', headers, body: JSON.stringify(body)
  }).then(r => r.json());

  const caseInfo = await post('medicalmanager/caseInfo', { subOrderNo });
  const caseId = caseInfo.data.caseId;
  const hospitalId = caseInfo.data.hospitalId;

  const [intend, latest, exce, hospAddr] = await Promise.all([
    post('register/getIntendClinicInfo', { caseId }),
    post('register/getLatestRegisterInfo', { subOrderNo }),
    post('register/ExceInfo', { subOrderNo }),
    hospitalId ? post('api/hospitalAddr', { hospitalId, supplierId: '3', hospitalName: caseInfo.data.intendHos }) : Promise.resolve(null)
  ]);

  const fileTypes = ['40', '41', '5000', '5001'];
  const imgPages = await Promise.all(fileTypes.map(ft =>
    post('ecm/getImage', { subOrderNo, fileType: ft, pageNum: 1, pageSize: 5 })
  ));
  const attachments = imgPages.flatMap((page, idx) => {
    const list = page?.data?.list ?? [];
    return list.map(item => ({
      fileType: fileTypes[idx],
      fileId: String(item.fileId),
      fileName: item.fileName,
      mimeType: `image/${item.fileDataType || 'jpeg'}`,
      base64: item.fileUrl   // 注意：fileUrl 实际是 base64
    }));
  });

  return {
    detail: { caseInfo: caseInfo.data, intendClinicInfo: intend?.data, latestRegisterInfo: latest?.data, hospitalAddr: hospAddr?.data ?? null, exceInfo: exce?.data ?? [] },
    attachments
  };
}
```

### 7.2 在 `claim` 指令 handler 里调用

```ts
async function handleClaim(cmd) {
  await clickClaimButtonInList(cmd.orderId);     // 现有逻辑
  const bundle = await fetchOrderDetail(cmd.subOrderNo).catch(err => ({ error: err.message }));
  ws.send(JSON.stringify({
    type: 'ORDER_DETAIL_FETCHED',
    payload: { sourceOrderNo: cmd.subOrderNo, ...bundle }
  }));
}
```

### 7.3 错误兜底

- 任何接口 401 / 跳登录 → 上报 `{ error: 'NEED_LOGIN' }`，托盘提示"插件登录态过期"
- 单接口超时（5s）→ 该字段置 null，其他字段继续，不阻塞主流程
- getImage 返回 `[]` 或非 jpg → 跳过该附件
- caseInfo 失败 → 整个 fetch 失败，上报 error

## 8. 托盘端改造

### 8.1 `OrderDetailModal.tsx` 重构

数据源切换：`order.rawJson` → 调 `GET /api/orders/:id/detail` 拿到的 `detail.caseInfo`（及辅助字段）。

字段映射（从 caseInfo 取，覆盖现有 9 个字段并扩展）：

| 分区 | 字段（label → caseInfo key） |
|---|---|
| **基础信息** | 泰康订单号 `subOrderNo` / 申请号 `applyNo` / CRM 申请号 `crmApplyNo` / 就诊人 `patientName` / 性别 `sex` / 生日 `birthday` / 证件类型 `cardType` / 证件号 `cardId` / 联系电话 `paMobile` / 客户等级 `cusLevel` |
| **就诊意向** | 医院 `intendHos` / 城市 `intendCity` / 科室 `intendDept` / 医生 `intendDoc` / 职称 `intendDocTitle` / 日期 `intendDate` / 时段 `intendDateAmorpm` / 疑似疾病 `suspectDisease` |
| **方案/产品** | 服务项 `serviceItemName` / 套餐 `packetName` / 方案 `planName` / 方案别名 `planAlias` / 产品 `productName` / 标签 `labelName` |
| **投保人/联系人** | 投保人 `insurName` / 投保人电话 (无字段，留空) / 紧急联系人 `ecpName` / 紧急联系人电话 `ecpPhone` / 关系 `patEcpRelationship` |
| **流程/状态** | 订单状态 `orderStateName` / 阶段 `stageName` / 申请方式 `applyWayDesc` / 申请时间 `applicationDate` / 受理时间 `mmgrApplyDate` / 预计出院 `estimateOutHospitalDate` |
| **附件** | OrderAttachment 列表，缩略图 + 点击放大 |

### 8.2 附件区组件 `AttachmentGallery`

新增组件，接 `attachments: { id, fileType, fileName, url }[]`：
- 网格布局，每张缩略图显示 `fileName` + fileType（先展示编号）
- 点击放大用全屏 lightbox 或新窗口打开

### 8.3 加载状态

打开弹窗时：
- 如果 `detailFetchedAt` 为空 → 显示"详情抓取中…"骨架屏
- 监听 WS `ORDER_DETAIL_READY` → 触发 refetch
- 失败 → 显示错误提示 + "重试"按钮（调 `POST /api/orders/:id/refresh-detail`）

## 9. 安全 / 风险

- **登录态依赖**：插件 fetch 用员工浏览器 cookie，员工换号 / cookie 过期会失败。已在 7.3 设计 NEED_LOGIN 兜底
- **风控**：HAR 中未见签名头，但批量调用仍有风险。MVP 阶段只在"申领后"触发，频率 = 申领频率，不主动批量预取
- **隐私**：身份证图片落 MinIO，桶不公网开放，只能通过后端 presigned URL（1h TTL）访问。员工 token 校验在 7.x 之后另开 issue
- **fileType 字典空白**：MVP 先展示编号，后续补语义对照表

## 10. 测试 / 验收

1. 现有库里挑一条 `status='已申领'` 的订单，手动调 `POST /api/orders/:id/refresh-detail`，验证：
   - `Order.detailJson` 被写入，结构符合 4.1
   - `OrderAttachment` 行数 ≥ 1，MinIO 桶有对应文件
   - 托盘弹窗能展示新字段 + 缩略图
2. 申领一条**新**订单，从点击"申领"到弹窗显示完整详情，端到端 < 5s
3. 主动断开插件 WS，模拟登录态失效，托盘弹窗显示"插件登录态过期"
4. 重复申领（同一订单第二次申领）→ `OrderAttachment` 不会重复入库（按 `[orderId, fileId]` upsert）

## 11. 拆解 To-Do（待第六步确认）

按"每步系统可运行"原则拆 5 个阶段，下一步对齐：

1. **后端：DB schema 升级**（Order 加字段 + 新建 OrderAttachment + MinIO bucket 初始化）
2. **后端：消息处理 + REST 接口**（处理 `ORDER_DETAIL_FETCHED`、新增 `/api/orders/:id/detail` 和 `/refresh-detail`）
3. **插件：detailFetcher 模块 + claim handler 接入**
4. **托盘：OrderDetailModal 重构 + AttachmentGallery 组件**
5. **端到端联调 + 验收脚本**

每个阶段都能独立验证、不破坏现有功能。
