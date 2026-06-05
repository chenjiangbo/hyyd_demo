const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const projectPath = path.join(repoRoot, 'packages/capture-sidecar/Hyyd.CaptureSidecar.csproj');
const outputDir = path.join(repoRoot, 'packages/tray-app/resources/capture-sidecar');

const arch = process.env.PROCESSOR_ARCHITECTURE || process.arch;
const runtime = /arm64|aarch64/i.test(arch) ? 'win-arm64' : 'win-x64';

if (!fs.existsSync(projectPath)) {
  console.error(`❌ sidecar project not found: ${projectPath}`);
  process.exit(1);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const args = [
  'publish',
  projectPath,
  '-c',
  'Release',
  '-r',
  runtime,
  '--self-contained',
  'true',
  '-p:PublishSingleFile=true',
  '-o',
  outputDir
];

console.log(`🔨 building capture sidecar runtime=${runtime}`);
const result = spawnSync('dotnet', args, {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (result.error) {
  console.error(`❌ failed to start dotnet: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`❌ dotnet publish failed with code ${result.status}`);
  process.exit(result.status ?? 1);
}

const exePath = path.join(outputDir, 'hyyd-capture-sidecar.exe');
if (!fs.existsSync(exePath)) {
  console.error(`❌ sidecar exe not found after publish: ${exePath}`);
  process.exit(1);
}

console.log(`✅ sidecar built: ${exePath}`);

