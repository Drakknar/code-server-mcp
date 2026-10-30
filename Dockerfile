# Packs the companion extension, so the image carries it without a binary in the repo.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS companion
RUN apk add --no-cache zip
COPY companion/ /companion/
RUN sh /companion/build.sh

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
COPY --from=companion /companion/*.vsix /app/companion/
CMD ["node", "/app/server.js"]
