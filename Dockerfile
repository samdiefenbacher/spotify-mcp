FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY spotify-openapi.yaml ./spotify-openapi.yaml
COPY src ./src

RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY spotify-openapi.yaml ./spotify-openapi.yaml

CMD ["node", "dist/index.js"]
