FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    python3-gi python3-gi-cairo \
    gir1.2-pango-1.0 \
    libcairo2-dev libpango1.0-dev \
    ffmpeg fontconfig \
    fonts-noto-color-emoji \
    wget curl yt-dlp \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages pycairo requests

WORKDIR /app
COPY . .

# Download Baloo Da 2 Bold font
RUN mkdir -p /app/fonts /usr/local/share/fonts/truetype/custom \
    && wget -q -O /app/fonts/BalooDa2-Bold.ttf \
       "https://github.com/EkType/BalooDa2/raw/master/fonts/ttf/BalooDa2-Bold.ttf" \
    || wget -q -O /app/fonts/BalooDa2-Bold.ttf \
       "https://fonts.gstatic.com/s/balooda2/v7/2nFuWnRgALanXAG_LOhwkasxIOQ.ttf" \
    && cp /app/fonts/BalooDa2-Bold.ttf /usr/local/share/fonts/truetype/custom/ \
    && fc-cache -f -v

RUN npm install

EXPOSE 3000
CMD ["node", "server.js"]
