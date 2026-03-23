import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import * as openaiApiModule from "@workspace/openai-api";
import * as signupModule from "@workspace/openai-signup";

export function registerAccountMaintenanceRoutes(app: Express, deps: any) {
  const {
    summarizeSignupResult,
    ensureDatabaseSchema,
    getOpenAIApiRuntimeConfig,
    resolveRateLimitForAccount,
    upsertOpenAIAccount,
    markAccountCoolingDown,
    listAvailableTeamOwners,
    getTeamOwnerAccountByEmail,
    getTeamOwnerEffectiveAvailableSlotsByEmail,
    listTeamOwnerMembersByEmail,
    inviteTeamOwnerMemberByEmail,
    removeTeamOwnerMemberByEmail,
    reloginTeamAccount,
    getOpenAIAccountByEmail,
    postCodexResponsesWithTokenRefresh,
    extractCodexResultFromSse,
    extractResponseUsage,
    ensureOpenAIModelsCacheLoaded,
    estimateUsageCost,
    updateOpenAIAccountRateLimitById,
    shouldPersistModelResponseLog,
    createModelResponseLog,
  } = deps;

  const createForbiddenError = () => {
    const error = new Error("Forbidden") as Error & { status?: number };
    error.status = 403;
    return error;
  };

  const ensureCanManageTeamOwner = async (res: Response, ownerEmail: string) => {
    const session = res.locals.portalSession as
      | { sub?: string | null; role?: string | null }
      | undefined;
    if ((session?.role ?? "").trim().toLowerCase() === "admin") {
      return;
    }
    const requesterUserId = session?.sub?.trim() ?? "";
    if (!requesterUserId) {
      throw createForbiddenError();
    }
    const owner = await getTeamOwnerAccountByEmail(ownerEmail);
    if (!owner) {
      throw createForbiddenError();
    }
    const portalUserId = owner.portalUserId?.trim() ?? "";
    const ownerId = owner.ownerId?.trim() ?? "";
    if (portalUserId !== requesterUserId && ownerId !== requesterUserId) {
      throw createForbiddenError();
    }
  };

  app.post(
    "/api/openai-accounts/register",
    async (req: Request, res: Response) => {
      const startedAt = Date.now();
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const maxSignupCount = Math.max(
          1,
          Number.isFinite(Number(process.env.OPENAI_SIGNUP_MAX_COUNT))
            ? Math.floor(Number(process.env.OPENAI_SIGNUP_MAX_COUNT))
            : 1000,
        );
        const rawCount =
          typeof body.count === "number" ? body.count : Number(body.count ?? 1);
        const safeCount = Number.isFinite(rawCount) ? Math.floor(rawCount) : 1;
        const count = Math.max(1, Math.min(maxSignupCount, safeCount));

        const rawConcurrency =
          typeof body.concurrency === "number"
            ? body.concurrency
            : Number(body.concurrency ?? 1);
        const safeConcurrency = Number.isFinite(rawConcurrency)
          ? Math.floor(rawConcurrency)
          : 1;
        const concurrency = Math.max(1, Math.min(count, safeConcurrency));

        if (typeof signupModule.runSignupBatch !== "function") {
          res.status(500).json({
            ok: false,
            durationMs: Date.now() - startedAt,
            error:
              "runSignupBatch is not exported from @workspace/openai-signup",
          });
          return;
        }

        const flowResult = await signupModule.runSignupBatch({
          count,
          concurrency,
          includeResults: true,
        });

        const accounts: Array<Record<string, any>> = [];
        if ("results" in flowResult && Array.isArray(flowResult.results)) {
          for (const item of flowResult.results) {
            if (item?.ok && item.account) {
              accounts.push(item.account);
            }
          }
        }

        if (accounts.length === 0) {
          res.status(500).json({
            ok: false,
            durationMs: Date.now() - startedAt,
            result: summarizeSignupResult(flowResult),
            error: "Signup flow did not return account payload",
          });
          return;
        }

        await ensureDatabaseSchema();
        const runtimeConfig = await getOpenAIApiRuntimeConfig();
        const savedAccounts = [];
        for (const account of accounts) {
          const rateLimit = await resolveRateLimitForAccount(account, runtimeConfig);
          const saved = await upsertOpenAIAccount({
            email: account.email,
            userId: account.userId,
            name: account.name,
            picture: account.picture,
            accountId: account.accountId,
            accountUserRole: account.accountUserRole,
            workspaceName: account.workspaceName,
            planType: account.planType,
            workspaceIsDeactivated: account.workspaceIsDeactivated,
            workspaceCancelledAt: account.workspaceCancelledAt,
            status: account.status,
            isShared: account.isShared,
            accessToken: account.accessToken,
            refreshToken: null,
            sessionToken: account.sessionToken,
            type: account.type,
            rateLimit,
          });
          await markAccountCoolingDown({
            account: saved,
            fallbackRateLimit: rateLimit,
          });
          savedAccounts.push(saved);
        }

        res.status(200).json({
          ok: true,
          durationMs: Date.now() - startedAt,
          requested: { count, concurrency },
          savedCount: savedAccounts.length,
          result: summarizeSignupResult(flowResult),
          savedAccount: savedAccounts[0] ?? null,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        res.status(500).json({
          ok: false,
          durationMs: Date.now() - startedAt,
          error: err.message,
          stack: err.stack,
        });
      }
    },
  );

  app.get(
    "/api/team-accounts/owner/available-teams",
    async (_req: Request, res: Response) => {
      try {
        const teams = await listAvailableTeamOwners();
        res.json({
          ok: true,
          teams,
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.get(
    "/api/team-accounts/owner/:email/available-slots",
    async (req: Request, res: Response) => {
      try {
        const emailParam = req.params.email;
        const email =
          typeof emailParam === "string"
            ? emailParam.trim().toLowerCase()
            : (emailParam?.[0] ?? "").trim().toLowerCase();
        if (!email) {
          res.status(400).json({ ok: false, error: "email is required" });
          return;
        }
        await ensureCanManageTeamOwner(res, email);
        const data = await getTeamOwnerEffectiveAvailableSlotsByEmail(email);
        res.json({
          ok: true,
          ...data,
        });
      } catch (error) {
        res.status(typeof (error as { status?: number }).status === "number" ? (error as { status: number }).status : 500).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.get(
    "/api/team-accounts/owner/:email/members",
    async (req: Request, res: Response) => {
      try {
        const emailParam = req.params.email;
        const email =
          typeof emailParam === "string"
            ? emailParam.trim().toLowerCase()
            : (emailParam?.[0] ?? "").trim().toLowerCase();
        if (!email) {
          res.status(400).json({ ok: false, error: "email is required" });
          return;
        }
        await ensureCanManageTeamOwner(res, email);
        const data = await listTeamOwnerMembersByEmail(email);
        res.json({
          ok: true,
          ...data,
        });
      } catch (error) {
        res.status(typeof (error as { status?: number }).status === "number" ? (error as { status: number }).status : 500).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post(
    "/api/team-accounts/owner/:email/members",
    async (req: Request, res: Response) => {
      try {
        const emailParam = req.params.email;
        const ownerEmail =
          typeof emailParam === "string"
            ? emailParam.trim().toLowerCase()
            : (emailParam?.[0] ?? "").trim().toLowerCase();
        const body = (req.body ?? {}) as Record<string, unknown>;
        const memberEmail =
          typeof body.memberEmail === "string" ? body.memberEmail.trim().toLowerCase() : "";
        if (!ownerEmail || !memberEmail) {
          res.status(400).json({ ok: false, error: "ownerEmail and memberEmail are required" });
          return;
        }
        await ensureCanManageTeamOwner(res, ownerEmail);
        const data = await inviteTeamOwnerMemberByEmail(ownerEmail, memberEmail);
        res.json({
          ok: true,
          ...data,
        });
      } catch (error) {
        res.status(typeof (error as { status?: number }).status === "number" ? (error as { status: number }).status : 500).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.delete(
    "/api/team-accounts/owner/:email/members",
    async (req: Request, res: Response) => {
      try {
        const emailParam = req.params.email;
        const ownerEmail =
          typeof emailParam === "string"
            ? emailParam.trim().toLowerCase()
            : (emailParam?.[0] ?? "").trim().toLowerCase();
        const body = (req.body ?? {}) as Record<string, unknown>;
        const memberEmail =
          typeof body.memberEmail === "string" ? body.memberEmail.trim().toLowerCase() : "";
        if (!ownerEmail || !memberEmail) {
          res.status(400).json({ ok: false, error: "ownerEmail and memberEmail are required" });
          return;
        }
        await ensureCanManageTeamOwner(res, ownerEmail);
        const data = await removeTeamOwnerMemberByEmail(ownerEmail, memberEmail);
        res.json({
          ok: true,
          ...data,
        });
      } catch (error) {
        res.status(typeof (error as { status?: number }).status === "number" ? (error as { status: number }).status : 500).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post(
    "/api/team-accounts/:email/relogin",
    async (req: Request, res: Response) => {
      const startedAt = Date.now();
      try {
        const emailParam = req.params.email;
        const email =
          typeof emailParam === "string" ? emailParam : (emailParam?.[0] ?? "");
        if (!email) {
          res.status(400).json({ ok: false, error: "email is required" });
          return;
        }

        const saved = await reloginTeamAccount(email);
        res.json({
          ok: true,
          durationMs: Date.now() - startedAt,
          account: saved,
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post(
    "/api/team-accounts/bulk-relogin",
    async (req: Request, res: Response) => {
      const startedAt = Date.now();
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const emails = Array.isArray(body.emails)
          ? body.emails.filter((item): item is string => typeof item === "string")
          : [];
        const normalizedEmails = Array.from(
          new Set(
            emails
              .map((item) => item.trim().toLowerCase())
              .filter((item) => item.length > 0),
          ),
        );
        if (normalizedEmails.length === 0) {
          res.status(400).json({ ok: false, error: "emails is required" });
          return;
        }

        const results: Array<{ email: string; ok: boolean; error?: string }> = [];
        for (const email of normalizedEmails) {
          try {
            await reloginTeamAccount(email);
            results.push({ email, ok: true });
          } catch (error) {
            results.push({
              email,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const successCount = results.filter((item) => item.ok).length;
        res.json({
          ok: true,
          durationMs: Date.now() - startedAt,
          total: results.length,
          successCount,
          failedCount: results.length - successCount,
          results,
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post(
    "/api/openai-accounts/:email/test",
    async (req: Request, res: Response) => {
      const startedAt = Date.now();
      try {
        const emailParam = req.params.email;
        if (typeof emailParam !== "string" || !emailParam.trim()) {
          res.status(400).json({ ok: false, error: "email param is required" });
          return;
        }
        const email = decodeURIComponent(emailParam);
        const account = await getOpenAIAccountByEmail(email);
        if (!account) {
          res.status(404).json({ ok: false, error: "Account not found" });
          return;
        }
        if (!account.accessToken) {
          res.status(400).json({ ok: false, error: "Account has no accessToken" });
          return;
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const model =
          typeof body.model === "string" && body.model.trim()
            ? body.model.trim()
            : "gpt-5.3-codex";
        const text =
          typeof body.text === "string" && body.text.trim()
            ? body.text.trim()
            : "test";
        const runtimeConfig = await getOpenAIApiRuntimeConfig();
        const version =
          typeof body.version === "string" && body.version.trim()
            ? body.version.trim()
            : runtimeConfig.clientVersion;
        const userAgent =
          typeof body.userAgent === "string" && body.userAgent.trim()
            ? body.userAgent.trim()
            : runtimeConfig.userAgent;

        const payload =
          typeof body.payload === "object" && body.payload !== null
            ? ({
                ...(body.payload as Record<string, unknown>),
                stream: true,
              } as Record<string, unknown>)
            : {
                model,
                instructions: "",
                input: [
                  {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text }],
                  },
                ],
                tools: [],
                tool_choice: "auto",
                parallel_tool_calls: false,
                reasoning: { effort: "medium", summary: "auto" },
                store: false,
                stream: true,
                include: ["reasoning.encrypted_content"],
                prompt_cache_key: crypto.randomUUID(),
              };

        const payloadIntentId =
          typeof payload.intent_id === "string" ? payload.intent_id : null;
        const payloadAttemptNo =
          typeof payload.attempt_no === "number" &&
          Number.isFinite(payload.attempt_no)
            ? Math.floor(payload.attempt_no)
            : null;
        const payloadIsFinal =
          typeof payload.is_final === "boolean" ? payload.is_final : null;
        const payloadRetryReason =
          typeof payload.retry_reason === "string" ? payload.retry_reason : null;
        const intentId =
          typeof body.intentId === "string" && body.intentId.trim()
            ? body.intentId.trim()
            : payloadIntentId;
        const attemptNo =
          typeof body.attemptNo === "number" && Number.isFinite(body.attemptNo)
            ? Math.floor(body.attemptNo)
            : payloadAttemptNo;
        const isFinal =
          typeof body.isFinal === "boolean" ? body.isFinal : payloadIsFinal;
        const retryReason =
          typeof body.retryReason === "string" && body.retryReason.trim()
            ? body.retryReason.trim()
            : payloadRetryReason;

        if (typeof openaiApiModule.postCodexResponses !== "function") {
          res.status(500).json({
            ok: false,
            durationMs: Date.now() - startedAt,
            error:
              "postCodexResponses is not exported from @workspace/openai-api",
          });
          return;
        }

        const upstreamRequestedAt = Date.now();
        const upstream = await postCodexResponsesWithTokenRefresh({
          module: openaiApiModule,
          account,
          payload,
          runtimeConfig: {
            userAgent,
            clientVersion: version,
          },
        });
        const ttfbMs = Math.max(0, Date.now() - upstreamRequestedAt);

        const upstreamStatus = upstream.status;
        const contentType = upstream.headers.get("content-type") ?? "";
        const responseText = await upstream.text();
        const latencyMs = Math.max(0, Date.now() - upstreamRequestedAt);
        const result = extractCodexResultFromSse(responseText);
        let responseJson: unknown = null;
        try {
          responseJson = JSON.parse(responseText);
        } catch {
          responseJson = null;
        }
        const { tokensInfo, totalTokens, errorCode, errorMessage } =
          extractResponseUsage(responseJson);
        await ensureOpenAIModelsCacheLoaded();
        const cost = estimateUsageCost(model, tokensInfo);

        let rateLimitUpdated = false;
        try {
          const latestRateLimit = await resolveRateLimitForAccount(
            {
              id: account.id,
              email: account.email,
              accessToken: account.accessToken,
              sessionToken: account.sessionToken,
              accountId: account.accountId,
              proxyId: account.proxyId,
              userId: account.userId,
            },
            runtimeConfig,
          );
          await markAccountCoolingDown({
            account,
            fallbackRateLimit: latestRateLimit,
          });
          await updateOpenAIAccountRateLimitById(account.id, latestRateLimit);
          rateLimitUpdated = true;
        } catch (error) {
          console.warn(
            `[test] rate_limit refresh failed for ${account.email}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try {
          if (shouldPersistModelResponseLog(req.path)) {
            await createModelResponseLog({
              intentId,
              attemptNo,
              isFinal,
              retryReason,
              path: req.path,
              modelId: model,
              keyId: null,
              statusCode: upstreamStatus,
              ttfbMs,
              latencyMs,
              tokensInfo,
              totalTokens,
              cost,
              errorCode,
              errorMessage:
                errorMessage ??
                (upstream.ok
                  ? null
                  : responseText.slice(0, 1000) || "upstream request failed"),
              requestTime: new Date(startedAt).toISOString(),
            });
          }
        } catch (error) {
          console.warn(
            `[logs] failed to write model response log: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        res.status(upstream.ok ? 200 : 500).json({
          ok: upstream.ok,
          durationMs: Date.now() - startedAt,
          upstreamStatus,
          contentType,
          rateLimitUpdated,
          result,
          response:
            responseJson ??
            (responseText.length > 4000
              ? `${responseText.slice(0, 4000)}...<truncated>`
              : responseText),
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        res.status(500).json({
          ok: false,
          durationMs: Date.now() - startedAt,
          error: err.message,
          stack: err.stack,
        });
      }
    },
  );
}
