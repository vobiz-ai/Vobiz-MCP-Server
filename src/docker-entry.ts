/**
 * Entry point of the container image. One image serves two audiences:
 *  - Cloud Run and self-hosters set VOBIZ_HOSTED_URL (the hosted connector cannot start without it), so the
 *    image runs the multi-tenant OAuth server.
 *  - Directory build systems (Glama, the Docker MCP catalog, ...) run the image with no environment and speak
 *    MCP over stdio to read the tool list, so the image runs the stdio server.
 * Explicit modes still work: `docker run ... vobiz-mcp node dist/index.js hosted`.
 */
if (process.env.VOBIZ_HOSTED_URL?.trim()) process.argv[2] = "hosted";
await import("./index.js");
