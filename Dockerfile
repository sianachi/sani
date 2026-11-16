FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir data && chown node:node data
COPY src/ src/

USER node
ENV SANI_HOST=0.0.0.0
EXPOSE 8765
CMD ["node", "src/index.ts"]
