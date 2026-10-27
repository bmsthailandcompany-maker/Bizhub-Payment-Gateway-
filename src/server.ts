import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
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
