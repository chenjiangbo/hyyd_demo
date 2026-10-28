const fs = require('node:fs')
const path = require('node:path')

module.exports = async function verifyNativeCollectors(context) {
  if (context.electronPlatformName !== 'win32') return
  const root = path.resolve(__dirname, '../../native-chat-collectors')
  const required = [
    path.join(root, 'wechat', 'hyyd-wechat-collector.exe'),
    path.join(root, 'wxwork', 'hyyd-wxwork-collector.exe')
  ]
  const missing = required.filter((file) => !fs.existsSync(file))
  if (missing.length) {
    throw new Error(`Windows 安装包缺少消息采集运行文件：${missing.map((file) => path.relative(root, file)).join(', ')}`)
  }
}
