# Vobiz MCP server image. Build: docker build -t vobiz-mcp .
# Hosted connector (multi-tenant, OAuth): docker run -p 3000:3000 -e VOBIZ_HOSTED_URL=https://mcp.example.com -e VOBIZ_HOSTED_SECRET=... vobiz-mcp
# Without VOBIZ_HOSTED_URL the image speaks MCP over stdio (docker run -i -e VOBIZ_AUTH_ID=... -e VOBIZ_AUTH_TOKEN=... vobiz-mcp),
# which is what directory build systems such as Glama run to read the tool list.
# Base image pinned by digest (multi-arch index of node:24-alpine, Node 24.22.0 / Alpine 3.24.2), so a rebuild
# is reproducible and a re-pushed tag cannot change what we ship. Dependabot (docker ecosystem) bumps the digest.
# Refresh by hand: docker buildx imagetools inspect node:24-alpine  (the top-level "Digest:").
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
LABEL io.modelcontextprotocol.server.name="io.github.vobiz-ai/vobiz-mcp" \
      org.opencontainers.image.source="https://github.com/vobiz-ai/Vobiz-MCP-Server" \
      org.opencontainers.image.description="Official Vobiz MCP server (hosted OAuth connector)" \
      org.opencontainers.image.licenses="MIT"
# ffmpeg is pinned to the exact Alpine package version (Alpine 3.24 community repo). Alpine drops superseded
# -rN builds from its mirrors, so when this stops resolving, or the base digest moves to a new Alpine release, bump it:
#   docker run --rm <the FROM image above> sh -c 'apk update >/dev/null && apk policy ffmpeg'
# The runtime only needs `node`: npm, npx and corepack are removed to shrink the attack surface.
RUN apk add --no-cache ffmpeg=8.1.2-r0 \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY skills ./skills
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/docker-entry.js"]
