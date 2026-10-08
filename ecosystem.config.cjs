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
      // Keep enough headroom to avoid killing the process between inline preflight
      // and the authoritative scheduled run.
      max_memory_restart: "768M",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || "3005",
      },
    },
  ],
};
