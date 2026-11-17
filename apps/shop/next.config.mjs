/** @type {import('next').NextConfig} */
export default {
  // Lets two builds of the app sit side by side (used when comparing a change
  // against its base).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};
