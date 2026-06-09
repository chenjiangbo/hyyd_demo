# admin-web · 寰宇医道管理后台

只读采集监控后台。设计文档：`docs/寰宇医道_管理后台设计.md`。

## 开发

```bash
# 1. 先起后端（需 PostgreSQL:15432 + MinIO:19000）
pnpm --filter @huanyu/backend dev      # 监听 13000

# 2. 起前端 dev server（5174，/api 与 /ws 代理到 13000）
pnpm --filter admin-web dev
```

浏览器开 http://localhost:5174 ，用 `ADMIN_PASSWORD` 登录。

## 构建

```bash
pnpm --filter admin-web build          # 产物在 dist/
```

生产期由后端 Fastify `@fastify/static` 把 `dist/` 挂到 `/admin/*`（部署待接）。

## 后端依赖的环境变量（packages/backend/.env）

- `ADMIN_PASSWORD` —— 管理员明文密码（demo 阶段）
- `ADMIN_JWT_SECRET` —— JWT 签发密钥（HS256，12h 过期）

## 鉴权

- `POST /api/v1/admin/login` 校验密码 → 签 JWT → httpOnly + sameSite=lax cookie
- 其余 `/api/v1/admin/*` 都需要该 cookie，缺失/失效返回 401
- 前端任意请求收到 401 会派发 `admin-unauthorized` 事件，自动弹回登录页

## 进度

**Phase 1（已完成，已对真实数据验证）**
- 后端：admin 鉴权 + `dashboard/{summary,timeseries,alerts}` + `employees` + `health`
- 前端：登录页 / 仪表盘（指标卡 + 近 7 天柱图 + 告警区）/ 员工列表 / 系统健康 / 设置
- 主题：复用 tray-app Claude 暖白主题，浅/深/跟随系统

**Phase 2（已完成，已对真实数据 + 浏览器验证）**
- 后端：`employees/:id`(+orders/materials/calls)、`orders`(浏览/搜索)、`orders/:id/full`、
  `materials`(浏览/筛选)、`materials/:id`、`calls`(浏览/筛选)、`calls/:id/recording-url`
  —— 列表统一 keyset 游标分页（PAGE_SIZE=50）
- 前端：员工详情（Presence / 订单 / 素材 / 通话 四 Tab）、订单详情聚合页
  （泰康字段中文标签铺平 + 未知字段原样 + 附件画廊 + 素材/通话时间线 + JSON debug）、
  素材浏览（筛选 + 图片 lightbox + 文本展开）、通话浏览（按需 presigned 录音播放 + 转写）
- 注：Presence 仅当前快照，后端不持久化历史时间线（schema 不动）；
  Material 无 sync_status 字段，故未做"同步状态"筛选

**Phase 2 反馈迭代（已完成验证）**
- 订单浏览改为「绿通业务 / 挂号业务」两个标签页（按 rawJson.poolType 过滤）
- 员工素材 Tab 改为主从布局：左侧客户/订单切换器，右侧显示选中订单的
  订单编号 / 受理编号(applyNo) / 客户电话 + 该订单素材时间线
- 通话浏览：未关联订单的通话加红色「未关联订单」徽标 + 左侧红条；
  新增「全部 / 仅未关联 / 仅已关联」筛选

**Phase 3（待做）**
- `/ws/admin` 实时推送（新素材 2s 内仪表盘上涨）
- 导出 / 脱敏开关等选做项

## 索引建议

暂无。后续若某统计变慢需要加 Prisma 索引，会记在此处由 owner 加迁移。
