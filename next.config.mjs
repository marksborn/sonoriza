/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // The generation engine only ever runs on the server.
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
