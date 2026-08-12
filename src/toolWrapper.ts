// Wrapper tipis di atas McpServer.registerTool yang nambah logging
// (nama tool, status ok/error, latency, symbol kalau ada di args) tanpa ubah
// behavior tool sama sekali -- try/catch/errorResult tiap tool tetap di
// masing-masing handler seperti sebelumnya, wrapper ini cuma observasi dari
// luar. Log lewat console.log biar otomatis ke-capture Cloudflare Workers
// Logs ([observability] enabled = true di wrangler.toml), tidak perlu
// integrasi service eksternal (Sentry dkk).
import type { McpServer, ToolCallback, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

interface SafeToolConfig<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema,
> {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

export function registerSafeTool<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
  server: McpServer,
  name: string,
  config: SafeToolConfig<OutputArgs, InputArgs>,
  cb: ToolCallback<InputArgs>,
): RegisteredTool {
  const wrapped = (async (...args: Parameters<ToolCallback<InputArgs>>) => {
    const start = Date.now();
    const firstArg = args[0] as Record<string, unknown> | undefined;
    const symbol =
      firstArg && typeof firstArg === "object" && "symbol" in firstArg ? String(firstArg.symbol) : undefined;

    try {
      const boundCb = cb as unknown as (...a: typeof args) => ReturnType<ToolCallback<InputArgs>>;
      const result = await boundCb(...args);
      const isError =
        typeof result === "object" && result !== null && "isError" in result && (result as { isError?: boolean }).isError === true;
      console.log(`[tool] ${name} ${isError ? "error" : "ok"} ${Date.now() - start}ms${symbol ? ` symbol=${symbol}` : ""}`);
      return result;
    } catch (err) {
      console.log(
        `[tool] ${name} error ${Date.now() - start}ms${symbol ? ` symbol=${symbol}` : ""}: ${(err as Error)?.message ?? String(err)}`,
      );
      throw err;
    }
  }) as unknown as ToolCallback<InputArgs>;

  return server.registerTool(name, config, wrapped);
}
