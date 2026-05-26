import * as Minio from 'minio'
import * as dotenv from 'dotenv'

dotenv.config()

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_HOST || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '19000', 10),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'huanyu',
  secretKey: process.env.MINIO_SECRET_KEY || 'huanyu_dev_pwd'
})

async function createBuckets() {
  const buckets = ['recordings', 'screenshots']
  console.log('开始检测并创建 MinIO 存储桶...')
  for (const bucket of buckets) {
    try {
      const exists = await minioClient.bucketExists(bucket)
      if (!exists) {
        await minioClient.makeBucket(bucket, 'us-east-1')
        console.log(`- 存储桶 "${bucket}" 创建成功!`)
      } else {
        console.log(`- 存储桶 "${bucket}" 已存在，跳过创建。`)
      }
    } catch (err: any) {
      console.error(`检测或创建存储桶 "${bucket}" 失败:`, err.message)
      throw err
    }
  }
}

createBuckets()
  .then(() => {
    console.log('存储桶初始化全部完成!')
    process.exit(0)
  })
  .catch((err) => {
    console.error('存储桶初始化失败:', err)
    process.exit(1)
  })
