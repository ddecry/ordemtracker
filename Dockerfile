FROM node:24-alpine
# ffmpeg e yt-dlp gravam o áudio e as capturas da live pública para a análise dos momentos
RUN apk add --no-cache ffmpeg python3 py3-pip && pip install --no-cache-dir --break-system-packages yt-dlp
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV DATA_DIR=/dados NODE_ENV=production
VOLUME /dados
EXPOSE 3030
CMD ["node", "server.js"]
