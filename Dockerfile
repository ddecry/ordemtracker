FROM node:24-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV DATA_DIR=/dados NODE_ENV=production
VOLUME /dados
EXPOSE 3030
CMD ["node", "server.js"]
