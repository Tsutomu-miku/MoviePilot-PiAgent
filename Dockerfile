FROM node:22.23.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
# npm honors an optional build-time npmrc, including a user's registry mirror.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --no-fund --no-audit
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22.23.1-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 AGENT_DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=node:node /app/apps/api/dist/src ./apps/api/dist/src
COPY --from=build --chown=node:node /app/apps/api/skills ./apps/api/skills
COPY --from=build --chown=node:node /app/apps/api/migrations ./apps/api/migrations
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/contracts ./packages/contracts
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm", "start"]
