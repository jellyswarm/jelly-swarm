import { type Account, type JobService, QuoteInput, ServiceError } from "@jelly/service";
import { TRPCError, initTRPC } from "@trpc/server";
import { type Hex, isHex } from "viem";
import { z } from "zod";
import { COPY } from "./copy";

/** §9.3 tRPC v11. The `jobs` router; auth, wallet, share, templates and credits join in Phase 7. */
export type TrpcContext = { service: JobService; account: Account | null };

const t = initTRPC.context<TrpcContext>().create({
  // Only the message of a ServiceError is safe to show; everything else is replaced.
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    message: error.cause instanceof ServiceError ? error.cause.message : error.code === "UNAUTHORIZED" ? COPY.unauthorized : COPY.internal,
    data: { code: shape.data.code, httpStatus: shape.data.httpStatus },
  }),
});

const CODE: Record<ServiceError["code"], TRPCError["code"]> = {
  not_found: "NOT_FOUND",
  invalid: "BAD_REQUEST",
  expired: "PRECONDITION_FAILED",
  not_ready: "CONFLICT",
  payment_required: "PRECONDITION_FAILED",
  forbidden: "FORBIDDEN",
};

const mapped = t.procedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof ServiceError) {
    throw new TRPCError({ code: CODE[result.error.cause.code], cause: result.error.cause });
  }
  return result;
});

const authed = mapped.use(({ ctx, next }) => {
  if (!ctx.account) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, account: ctx.account } });
});

const jobKey = z.string().refine((s): s is Hex => isHex(s) && s.length === 66);

const jobs = t.router({
  quote: authed.input(QuoteInput).mutation(({ ctx, input }) => ctx.service.quote(ctx.account, input)),
  fund: authed
    .input(z.object({ quoteId: z.string().uuid(), route: z.enum(["wallet", "x402"]), payer: z.string() }))
    .mutation(({ ctx, input }) => ctx.service.prepare(ctx.account, input.quoteId, input.route, input.payer)),
  confirm: authed.input(z.object({ jobKey })).mutation(({ ctx, input }) => ctx.service.confirm(ctx.account, input.jobKey)),
  get: authed
    .input(z.object({ jobKey, sinceSeq: z.number().int().nonnegative().default(0) }))
    .query(({ ctx, input }) => ctx.service.status(ctx.account, input.jobKey, input.sinceSeq)),
  list: authed
    .input(z.object({ limit: z.number().int().min(1).max(100).default(25) }).default({ limit: 25 }))
    .query(({ ctx, input }) => ctx.service.list(ctx.account, input.limit)),
  result: authed
    .input(z.object({ jobKey, format: z.enum(["json", "csv", "md"]).default("json") }))
    .query(({ ctx, input }) => ctx.service.result(ctx.account, input.jobKey, input.format)),
  dispute: authed
    .input(z.object({ jobKey, rowIdx: z.array(z.number().int().nonnegative()).min(1).max(25), evidence: z.string().max(4000).default("") }))
    .mutation(({ ctx, input }) => ctx.service.dispute(ctx.account, input.jobKey, input.rowIdx, input.evidence) as Promise<object>),
});

export const appRouter = t.router({ jobs });
export type AppRouter = typeof appRouter;
