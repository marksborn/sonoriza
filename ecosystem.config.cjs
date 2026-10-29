// PM2 process definition for CloudPanel deployment.
//   pm2 start ecosystem.config.cjs
//   pm2 save
module.exports = {
  apps: [
    {
      name: "sonoriza",
      // Runs the Next.js production server on the port CloudPanel proxies to.
      script: "node_modules/next/dist/bin/next",
      args: "start",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // #435 Gate 3E: observed scheduled generation peaks ~541 MiB RSS.
      // #442: 768M was exceeded on 2026-10-29 (837 MiB); production was raised
      // to 1G by the operator. Keep the repository aligned with that value.
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || "3005",
        // #442: ~180 MiB of idle RSS sat in glibc per-thread malloc arenas
        // (native threads: Prisma engine, libuv). Cap the arena count so freed
        // native memory is reused instead of fragmenting across ~20 arenas.
        MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX || "2",
      },
    },
  ],
};
