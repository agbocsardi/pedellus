// Test fixture: own a managed workspace in a separate process so the parent can SIGKILL it.
import { createExecutionEnv } from "../../dist/execution/index.js";

const store = process.argv[2];
if (!store) throw new Error("missing storage directory argument");
const env = await createExecutionEnv({ storageDirectory: store });
process.stdout.write(`${JSON.stringify({ id: env.workspaceId })}\n`);
setInterval(() => {}, 1000);
