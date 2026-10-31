import fs from "node:fs";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();

// Fail early with a clear message when the data folder is not writable (e.g. a Railway volume mounted as root).
try {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.accessSync(config.dataDir, fs.constants.W_OK);
} catch {
  console.error(
    `DATA_DIR ${config.dataDir} is not writable by this process (uid ${process.getuid?.() ?? "?"}). ` +
      "On Railway set the variable RAILWAY_RUN_UID=0 so the app can write to the attached volume.",
  );
  process.exit(1);
}
const { app, runJobs } = await buildApp(config);

let timer: NodeJS.Timeout | undefined;
if (config.workerIntervalMs > 0) {
  timer = setInterval(() => {
    runJobs().catch((err) => app.log.error(err, "background job failed"));
  }, config.workerIntervalMs);
}

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: "0.0.0.0" });
