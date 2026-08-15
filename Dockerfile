FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js circuit.js quiz.js ./
COPY fonts/ ./fonts/

EXPOSE 8080

CMD ["node", "server.js"]
