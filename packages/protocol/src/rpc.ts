import { z } from "zod";

export const JSON_RPC_VERSION = "2.0" as const;

export const JsonRpcIdSchema = z.union([z.string(), z.number().int()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcResponseSchema = z.union([
  z.object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    result: z.unknown(),
  }),
  z.object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema.nullable(),
    error: JsonRpcErrorSchema,
  }),
]);
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Harnex L0 security & lifecycle codes
  SandboxDenied: -32001,
  ApprovalRequired: -32002,
  ApprovalDenied: -32003,
  HookUntrusted: -32004,
  BudgetExceeded: -32005,
  ImmutablePathViolation: -32006,
  GitMergeConflict: -32007,
  SidecarUnavailable: -32008,
  SidecarRpcTimeout: -32009,
} as const;
