import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The Zcash scanner is a native module: it is loaded by Node at run time, not bundled.
  serverExternalPackages: ['@ledgerhq/zcash-utils'],
  poweredByHeader: false,
};

export default nextConfig;
