FROM node:20-bookworm

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv python3-dev build-essential \
    ffmpeg exiftool libraw-bin liblcms2-2 libgl1 libglib2.0-0 gphoto2 \
    && rm -rf /var/lib/apt/lists/*

# Keep Python dependencies isolated from Debian's system Python.
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY engine/requirements.txt /tmp/requirements.txt
RUN python -m pip install --upgrade pip setuptools wheel && \
    python -m pip install --no-cache-dir --prefer-binary -r /tmp/requirements.txt

COPY . .
ENV DATA_DIR=/tmp/lumina-data
ENV HF_HOME=/tmp/lumina-data/models/huggingface
ENV TORCH_HOME=/tmp/lumina-data/models/torch
CMD ["npm","start"]
