import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The Zcash scanner is a native module: it is loaded by Node at run time, not bundled.
  serverExternalPackages: ['@ledgerhq/zcash-utils'],
  poweredByHeader: false,
  // Lets two servers run from one checkout, each with its own output directory.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // The development server writes no files of its own into the project.
  agentRules: false,
};

export default nextConfig;
