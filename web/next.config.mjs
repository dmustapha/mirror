/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_API_URL: "https://mirror-daemon.onrender.com",
  },
};
export default nextConfig;
