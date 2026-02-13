FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./
ENV PORT=3005
EXPOSE 3005
CMD ["node", "server.js"]
