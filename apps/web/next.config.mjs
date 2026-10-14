/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // @dleads/db ships raw TypeScript source, so let Next transpile it.
  transpilePackages: ["@dleads/db"],
  reactStrictMode: true,
  webpack: (config) => {
    // @dleads/db uses ESM-style ".js" import specifiers that point at .ts files.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
