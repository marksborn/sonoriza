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
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || "3000",
      },
    },
  ],
};
