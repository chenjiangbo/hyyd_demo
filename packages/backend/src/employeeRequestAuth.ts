export function isEmployeeAuthExemptPath(url: string): boolean {
  return url === '/health' ||
    url === '/api/v1/login' ||
    url.startsWith('/ws') ||
    url.startsWith('/api/v1/admin') ||
    url.startsWith('/api/v1/order-attachments/') ||
    url.startsWith('/admin') ||
    url.startsWith('/ext') ||
    url.startsWith('/download') ||
    url.startsWith('/api/v1/departments') ||
    url.startsWith('/api/v1/hospitals') ||
    url.startsWith('/api/v1/doctors') ||
    url.startsWith('/api/v1/channels') ||
    url.startsWith('/api/v1/internal-products') ||
    url.startsWith('/api/v1/payment-channels') ||
    url.startsWith('/api/v1/escorts') ||
    url.startsWith('/api/v1/regions') ||
    url.startsWith('/api/v1/dim_cslb') ||
    url.startsWith('/m/') ||
    url.startsWith('/api/v1/escort-feedback') ||
    url.startsWith('/api/v1/pingan/')
}
