# The verifier service as its own container. Types are stripped by Node 24, no build step.
FROM node:24-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/semantic/package.json packages/semantic/
COPY services/verifier/package.json services/verifier/
RUN pnpm install --frozen-lockfile --prod
COPY packages ./packages
COPY services ./services
COPY examples ./examples
ENV PORT=8787 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "services/verifier/src/server.ts"]
