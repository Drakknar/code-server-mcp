# Packs the companion extension, so the image carries it without a binary in the repo.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS companion
RUN apk add --no-cache zip
COPY companion/ /companion/
RUN sh /companion/build.sh

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
COPY --from=companion /companion/*.vsix /app/companion/
CMD ["node", "/app/server.js"]
