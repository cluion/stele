# 由 repo 根目錄建置:docker build -f apps/server/Dockerfile -t stele-server .
FROM node:24-slim AS build
RUN npm install -g pnpm@10
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@stele/server..."
RUN pnpm --filter @stele/server build
# deploy 產出只含 production 依賴的獨立 node_modules,native module 由 lockfile 版本編譯
RUN pnpm --filter @stele/server deploy --prod --legacy /out && cp apps/server/dist/main.cjs /out/main.cjs

FROM node:24-slim
ENV NODE_ENV=production STELE_DATA=/data/stele.db PORT=4800
WORKDIR /srv
COPY --from=build /out .
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4800
USER node
CMD ["node", "main.cjs"]
