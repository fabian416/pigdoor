# The verifier runs as its own process with its own key, so it ships as its own
# image. Node 22 strips TypeScript types at run time, so there is no build step:
# what runs is the source in the repo, which is also what a judge reads.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable

# Workspace manifests first, so a dependency change is the only thing that
# busts the install layer.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json      ./packages/core/
COPY packages/semantic/package.json  ./packages/semantic/
COPY services/verifier/package.json  ./services/verifier/

RUN pnpm install --frozen-lockfile --filter @witness/verifier-service...

COPY packages ./packages
COPY services ./services

ENV PORT=8787
EXPOSE 8787

# Evidence and signed envelopes live here. Mount a volume to keep them.
ENV DATA_DIR=/data
RUN mkdir -p /data

CMD ["node", "services/verifier/src/server.ts"]
