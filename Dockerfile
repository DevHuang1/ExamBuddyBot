FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js circuit.js circuit-spec.js quiz.js ./
COPY fonts/ ./fonts/

EXPOSE 8080

CMD ["node", "server.js"]
