FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tenant-db.js collector.js console-bff.js console-jwt.js dashboard-routes.js fullstory-csv.js fullstory-activation-proxy.js ./
COPY sdk ./sdk/
COPY admin-portal ./admin-portal/

ENV NODE_ENV=production
ENV PORT=3000
# Overridden per deploy; /tmp is fine when only /v1 + Postgres is used (no disk volume).
ENV WAREHOUSE_PATH=/tmp/warehouse.jsonl

EXPOSE 3000

CMD ["node", "collector.js"]
