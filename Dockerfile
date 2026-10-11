# One Dockerfile, one target per service. TypeScript runs through tsx, so there is
# no separate compile step for the Node services.
#
# docker compose selects a stage with `target:`. Platforms that can't pick a target
# (Railway) build the final `selected` stage and pass SERVICE_TARGET as a build arg.
ARG SERVICE_TARGET=api

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/broker/package.json packages/broker/
COPY packages/test-harness/package.json packages/test-harness/
COPY apps/api/package.json apps/api/
COPY apps/consumer/package.json apps/consumer/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

FROM deps AS source
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps

FROM source AS migrate
CMD ["node", "--import", "tsx", "packages/db/src/migrate-cli.ts"]

FROM source AS api
ENV PORT=8080
EXPOSE 8080
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]

FROM source AS consumer
CMD ["node", "--import", "tsx", "apps/consumer/src/main.ts"]

FROM source AS web-build
RUN npm run build -w @telemetry/web

FROM nginx:1.27-alpine AS web
# The entrypoint renders templates with envsubst; 15-local-resolvers fills NGINX_LOCAL_RESOLVERS.
ENV API_UPSTREAM=http://api:8080
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html

FROM ${SERVICE_TARGET} AS selected
