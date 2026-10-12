import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The Zcash scanner is a native module: it is loaded by Node at run time, not bundled.
  serverExternalPackages: ['@ledgerhq/zcash-utils'],
  poweredByHeader: false,
  // The development server writes no files of its own into the project.
  agentRules: false,
};

export default nextConfig;
