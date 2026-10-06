# One image: the Bun web app, its API and the hosted MCP endpoint. dev2 builds this
# on every merge to master. The desktop app is not part of it.
FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY package.json bun.lock* ./
COPY apps/web/package.json apps/web/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY packages/db/package.json packages/db/
COPY packages/payments/package.json packages/payments/
RUN bun install --production --frozen-lockfile || bun install --production
COPY . .
# dev2's umask 007 leaves copied files unreadable to the bun user otherwise.
RUN chmod -R a+rX /app
USER bun
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/web/src/main.js"]
