/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@supabase/supabase-js"],
  webpack: (config: {
    externals: string[];
    resolve: { alias?: Record<string, string | false | string[]> };
  }) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    // Base Account is disabled. Its Coinbase SDK import is optional and does not resolve.
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@base-org/account": false,
    };
    return config;
  },
};

export default nextConfig;
