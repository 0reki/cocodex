import type { Request, Response } from "express";
import {
  buildCodexUserAgent,
  getCodexClientVersion,
} from "../../../openai-api/internal/client-identity.ts";

export function createOpenAIRuntimeServices() {
  function getOpenAIApiRuntimeConfig() {
    const clientVersion = getCodexClientVersion();
    return Promise.resolve({
      userAgent: buildCodexUserAgent(clientVersion),
      clientVersion,
    });
  }

  function createRequestAbortContext(req: Request, res: Response) {
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) controller.abort();
    };
    const onResponseClose = () => {
      if (!res.writableEnded) abort();
    };
    req.on("aborted", abort);
    res.on("close", onResponseClose);
    return {
      signal: controller.signal,
      cleanup: () => {
        req.off("aborted", abort);
        res.off("close", onResponseClose);
      },
    };
  }

  return { getOpenAIApiRuntimeConfig, createRequestAbortContext };
}
