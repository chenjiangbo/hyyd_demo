#!/usr/bin/env node
/**
 * 打包 Chrome 插件为 .crx + 生成自动更新清单 update.xml。
 *
 * 用法：node scripts/pack-extension.js
 * 产物：packages/extension/release/
 *   ├─ huanyu-extension.crx   （上传到后端 /ext/ 托管）
 *   └─ update.xml             （上传到后端 /ext/ 托管）
 *
 * 依赖：本机安装 Google Chrome（用其 --pack-extension），以及 packages/extension/key.pem 私钥。
 * 扩展 ID 由 key.pem 派生，固定为 EXT_ID。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'packages/extension');
const DIST = path.join(EXT_DIR, 'dist');
const KEY = path.join(EXT_DIR, 'key.pem');
const RELEASE = path.join(EXT_DIR, 'release');

// 与 manifest 的 key、注册表脚本保持一致
const EXT_ID = 'akaojickfipoeobmiokkdbdaimeifmoa';
const BACKEND_BASE = 'http://47.95.14.233:9093/ext';
const CRX_NAME = 'huanyu-extension.crx';

const CHROME =
  process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function main() {
  if (!fs.existsSync(KEY)) {
    console.error(`❌ 找不到签名私钥 ${KEY}，无法打包（私钥不进 git，需本地保管）`);
    process.exit(1);
  }

  // 1. 构建最新 dist
  console.log('▶ 构建插件 dist...');
  run('npx tsup', { cwd: EXT_DIR });

  // 2. 用 Chrome 打包 .crx（crx3 格式）
  console.log('▶ 打包 .crx...');
  run(
    `"${CHROME}" --pack-extension="${DIST}" --pack-extension-key="${KEY}" --no-message-box`
  );

  // Chrome 会在 dist 同级生成 dist.crx
  const generated = path.join(EXT_DIR, 'dist.crx');
  if (!fs.existsSync(generated)) {
    console.error('❌ 未找到生成的 dist.crx，打包失败');
    process.exit(1);
  }

  // 3. 整理到 release/
  fs.mkdirSync(RELEASE, { recursive: true });
  const crxOut = path.join(RELEASE, CRX_NAME);
  fs.renameSync(generated, crxOut);

  // 4. 读版本号，生成 update.xml
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  const updateXml = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${EXT_ID}'>
    <updatecheck codebase='${BACKEND_BASE}/${CRX_NAME}' version='${version}' />
  </app>
</gupdate>
`;
  fs.writeFileSync(path.join(RELEASE, 'update.xml'), updateXml);

  console.log('\n✅ 打包完成：');
  console.log(`   ${crxOut}`);
  console.log(`   ${path.join(RELEASE, 'update.xml')}  (version=${version})`);
  console.log(`\n下一步：把 release/ 下两个文件上传到后端，使其可通过：`);
  console.log(`   ${BACKEND_BASE}/${CRX_NAME}`);
  console.log(`   ${BACKEND_BASE}/update.xml`);
  console.log(`访问到。`);
}

main();
