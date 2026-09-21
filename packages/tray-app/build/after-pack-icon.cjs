const fs = require('fs');
const path = require('path');

let resedit;
try {
  resedit = require('resedit');
} catch {
  const resolved = require.resolve('resedit', {
    paths: [__dirname, path.resolve(__dirname, '..'), process.cwd()]
  });
  resedit = require(resolved);
}

module.exports = async function (context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const projectDir = (context.packager && context.packager.projectDir) || path.resolve(__dirname, '..');
  const exeName =
    context.packager && context.packager.appInfo && context.packager.appInfo.productFilename
      ? `${context.packager.appInfo.productFilename}.exe`
      : 'tray-app.exe';

  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(projectDir, 'resources', 'icon.ico');

  if (!fs.existsSync(exePath)) {
    console.warn(`[after-pack-icon] Target executable not found: ${exePath}`);
    return;
  }

  if (!fs.existsSync(iconPath)) {
    console.warn(`[after-pack-icon] Icon file not found: ${iconPath}`);
    return;
  }

  console.log(`[after-pack-icon] Injecting icon from "${iconPath}" into "${exePath}" via resedit...`);

  try {
    const exeBuf = fs.readFileSync(exePath);
    const exe = resedit.NtExecutable.from(exeBuf);
    const res = resedit.NtExecutableResource.from(exe);

    const iconBuf = fs.readFileSync(iconPath);
    const iconFile = resedit.Data.IconFile.from(iconBuf);
    const iconItems = iconFile.icons.map((item) => item.data);

    // 探测现有的 icon group id / lang，缺省为 id: 1, lang: 1033 (en-US)
    const existingGroups = resedit.Resource.IconGroupEntry.fromEntries(res.entries);
    const targetId = existingGroups.length > 0 ? existingGroups[0].id : 1;
    const targetLang = existingGroups.length > 0 ? existingGroups[0].lang : 1033;

    resedit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, targetId, targetLang, iconItems);
    res.outputResource(exe);

    const newBuf = Buffer.from(exe.generate());
    fs.writeFileSync(exePath, newBuf);
    console.log(
      `[after-pack-icon] Successfully injected ${iconItems.length} icon resolutions into ${exeName} (${newBuf.length} bytes).`
    );
  } catch (err) {
    console.error(`[after-pack-icon] Error injecting icon:`, err);
    throw err;
  }
};
