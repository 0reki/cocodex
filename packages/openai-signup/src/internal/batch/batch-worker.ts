export * from "../shared/flow.ts";
export * from "./batch.ts";
export * from "./worker.ts";

import { startSignupWorkerThreadIfNeeded } from "./worker.ts";

startSignupWorkerThreadIfNeeded();
