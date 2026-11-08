import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@bigtours/shared'],
  agentRules: false,
  devIndicators: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.API_URL ?? 'http://localhost:4000'}/api/:path*` }];
  },
  async headers() {
    return [
      {
        // 設定密碼連結放在網址中，Referer 只送網域，不含路徑；也不可被搜尋引擎收錄
        // /{代號}/{活動}/set-password/…、/{代號}/admin/set-password/…、/{代號}/company/set-password/…
        source: '/:agency/:section/set-password/:token',
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
