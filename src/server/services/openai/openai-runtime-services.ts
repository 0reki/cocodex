import type { Request, Response } from "express";

export function createOpenAIRuntimeServices(deps: {
  defaultOpenAIApiUserAgent: string;
  defaultOpenAIApiClientVersion: string;
}) {
  function getOpenAIApiRuntimeConfig() {
    return Promise.resolve({
      userAgent:
        process.env.OPENAI_API_USER_AGENT?.trim() ||
        deps.defaultOpenAIApiUserAgent,
      clientVersion:
        process.env.CODEX_CLIENT_VERSION?.trim() ||
        deps.defaultOpenAIApiClientVersion,
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
