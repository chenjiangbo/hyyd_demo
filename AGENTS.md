# 项目约定

## 数据库时间字段

- 所有表示某个日期和时刻的业务字段统一使用无时区类型，数据库存北京时间（UTC+8）的年月日和钟点值。
- PostgreSQL 列使用 `TIMESTAMP WITHOUT TIME ZONE`；Prisma `DateTime` 字段使用 `@db.Timestamp(...)`，禁止使用 `TIMESTAMPTZ`、`TIMESTAMP WITH TIME ZONE` 或 Prisma `@db.Timestamptz(...)`。
- 仅表示日期的字段使用 `DATE`；仅表示一天内时刻的字段使用 `TIME WITHOUT TIME ZONE`。不要给这类业务字段附加时区。
- 新增或修改字段时，同步检查 Prisma schema、建表/迁移 SQL、原生 SQL 写入与客户端展示，确保新字段保持上述规则。数据库连接时区固定为 `Asia/Shanghai`。

## Git 提交说明

- 执行 Git 提交时，提交标题和正文中的变更描述必须使用中文。可以保留 `feat:`、`fix:` 等类型前缀，但前缀后的描述必须是中文。
- 推送完成后，向用户汇报提交内容时使用中文。

## 界面与功能设计

- 只实现需求明确提出且有实际业务用途的功能、按钮、状态和文案；不得基于自己的理解擅自增加流程、功能或解释性文字。
- 页面结构和文案应从客户的实际操作路径与业务认知出发，使用客户能理解的语言。需求含义不清时先核对，不凭空补充设计。
