import type { NextConfig } from 'next';

const configuration: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  async rewrites() {
    const internal = (process.env.API_INTERNAL_URL || 'http://127.0.0.1:4001/api/v1').replace(/\/$/, '');
    return [{ source: '/api/v1/:path*', destination: `${internal}/:path*` }];
  },
};
export default configuration;
