#!/bin/bash
set -e

# 确保在项目根目录下执行
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "==========================================="
echo "   寰宇医道 MVP 本地开发环境初始化脚本"
echo "==========================================="

# 1. 启动 Docker 容器
echo "1. 正在启动 PostgreSQL 与 MinIO Docker 容器..."
docker compose up -d huanyu-postgres huanyu-minio

# 2. 等待 PostgreSQL 服务可用
echo "2. 正在等待 PostgreSQL 数据库服务就绪..."
until docker exec huanyu-postgres pg_isready -U huanyu -d huanyu >/dev/null 2>&1; do
  echo "   [等待中...] PostgreSQL 尚未就绪，5秒后重试..."
  sleep 5
done
echo "   [Ready!] PostgreSQL 数据库已就绪!"

# 3. 安装依赖
echo "3. 正在安装 Pnpm Workspace 依赖..."
pnpm install

# 4. 初始化数据库表结构
echo "4. 正在通过 Prisma 初始化数据库结构..."
cd "$PROJECT_ROOT/packages/backend"
npx prisma db push --skip-generate
npx prisma generate

# 5. 初始化 MinIO 存储桶
echo "5. 正在初始化 MinIO 存储桶..."
npx tsx scripts/create-buckets.ts

# 6. 注入种子数据
echo "6. 正在注入种子测试数据..."
npx tsx prisma/seed.ts

echo "==========================================="
echo "   [成功!] 寰宇医道本地开发基础设施搭建完毕!"
echo "   - 后端服务运行环境: packages/backend"
echo "   - PostgreSQL 连接地址: postgresql://huanyu:huanyu_dev_pwd@localhost:15432/huanyu"
echo "   - MinIO 控制台页面: http://localhost:19001"
echo "==========================================="
