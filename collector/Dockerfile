FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tenant-db.js collector.js ./

ENV NODE_ENV=production
ENV PORT=3000
ENV WAREHOUSE_PATH=/data/warehouse.jsonl

EXPOSE 3000

CMD ["node", "collector.js"]
