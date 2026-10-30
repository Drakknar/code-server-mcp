# Packs the companion extension, so the image carries it without a binary in the repo.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS companion
RUN apk add --no-cache zip
COPY companion/ /companion/
RUN sh /companion/build.sh

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
COPY --from=companion /companion/*.vsix /app/companion/
CMD ["node", "/app/server.js"]
