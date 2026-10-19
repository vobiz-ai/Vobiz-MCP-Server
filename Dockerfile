# Hosted Vobiz MCP connector (multi-tenant, OAuth). Build: docker build -t vobiz-mcp .
# Run: docker run -p 3000:3000 -e VOBIZ_HOSTED_URL=https://mcp.example.com -e VOBIZ_HOSTED_SECRET=... vobiz-mcp
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
LABEL io.modelcontextprotocol.server.name="io.github.vobiz-ai/vobiz-mcp" \
      org.opencontainers.image.source="https://github.com/vobiz-ai/Vobiz-MCP-Server" \
      org.opencontainers.image.description="Official Vobiz MCP server (hosted OAuth connector)" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY skills ./skills
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/hosted.js"]
