import { createMockIotServer } from "./mock-app.mjs";

const runtime = await createMockIotServer();

if (process.env.NODE_ENV !== "test") {
  const { host, port } = await runtime.listen();
  console.log(`IoT mock server listening on http://${host}:${port}`);
}

export { runtime };

