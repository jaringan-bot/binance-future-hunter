// Deno Deploy entrypoint. Set the project's entrypoint to `deno.mjs`.
// Grant env access is automatic on Deno Deploy; locally run with:
//   deno run --allow-net --allow-env deno.mjs
import { handleBinanceProxy } from "./handler.mjs";

Deno.serve((req) => handleBinanceProxy(req));
