# node:26-slim (Debian), mesma major do ambiente de desenvolvimento.
# Debian em vez de Alpine: Prisma e argon2 têm binários prontos para glibc;
# em musl você acaba compilando na mão.
FROM node:26-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && cp -r src/templates dist/templates

FROM base AS producao
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
