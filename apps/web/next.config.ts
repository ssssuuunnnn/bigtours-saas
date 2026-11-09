import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@bigtours/shared'],
  allowedDevOrigins: ['lvh.me', '*.lvh.me'],
  agentRules: false,
  devIndicators: false,
  async redirects() {
    const domain = process.env.PLATFORM_DOMAIN;
    // 正式環境 www.平台網域 轉到 平台網域，只保留一個官網網址
    const www = process.env.NODE_ENV === 'production' && domain
      ? [{ source: '/:path*', has: [{ type: 'host' as const, value: `www.${domain.replace(/\./g, '\\.')}` }], destination: `https://${domain}/:path*`, permanent: true }]
      : [];
    return [...www, { source: '/', has: [{ type: 'host', value: 'platform\\..*' }], destination: '/platform', permanent: false }];
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.API_URL ?? 'http://localhost:4000'}/api/:path*` }];
  },
  async headers() {
    return [
      {
        // 設定密碼連結放在網址中，Referer 只送網域，不含路徑；也不可被搜尋引擎收錄
        source: '/:slug/set-password/:token',
        headers: [
          { key: 'Referrer-Policy', value: 'strict-origin' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};

export default config;
