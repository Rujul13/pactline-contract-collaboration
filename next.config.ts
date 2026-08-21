import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/__scheduled",
        destination: "/api/scheduled",
      },
    ];
  },
};

export default nextConfig;
