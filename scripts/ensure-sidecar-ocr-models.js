const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const modelDir = path.join(repoRoot, 'packages', 'capture-sidecar', 'models', 'v5');

const baseUrl = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master';
const files = [
  {
    name: 'ch_PP-OCRv5_det_mobile.onnx',
    url: `${baseUrl}/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx`,
    sha256: '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae',
  },
  {
    name: 'ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx',
    url: `${baseUrl}/onnx/PP-OCRv5/cls/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx`,
    sha256: '54379ae5174d026780215fc748a7f31910dee36818e63d49e17dc598ecc82df7',
  },
  {
    name: 'ch_PP-OCRv5_rec_mobile.onnx',
    url: `${baseUrl}/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx`,
    sha256: '5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5',
  },
  {
    name: 'ppocrv5_dict.txt',
    url: `${baseUrl}/paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt`,
    sha256: 'd1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b',
  },
];

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function download(url, dest) {
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { force: true });
  const result = spawnSync('curl', [
    '-L',
    '--fail',
    '--connect-timeout',
    '15',
    '--max-time',
    '300',
    '-o',
    tmp,
    url,
  ], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw new Error(`failed to start curl: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`curl failed with code ${result.status}: ${url}`);
  }
  fs.renameSync(tmp, dest);
}

async function main() {
  fs.mkdirSync(modelDir, { recursive: true });
  for (const file of files) {
    const dest = path.join(modelDir, file.name);
    if (fs.existsSync(dest)) {
      const got = sha256(dest);
      if (got === file.sha256) {
        console.log(`✓ OCR model ready: ${file.name}`);
        continue;
      }
      throw new Error(`OCR model hash mismatch: ${dest}\nexpected ${file.sha256}\nactual   ${got}`);
    }

    console.log(`⬇ downloading OCR model: ${file.name}`);
    download(file.url, dest);
    const got = sha256(dest);
    if (got !== file.sha256) {
      throw new Error(`OCR model hash mismatch after download: ${dest}\nexpected ${file.sha256}\nactual   ${got}`);
    }
    console.log(`✓ OCR model downloaded: ${file.name}`);
  }
}

main().catch((error) => {
  console.error(`❌ ensure sidecar OCR models failed: ${error.message}`);
  process.exit(1);
});
