# Lumina Photo Studio

A Render-backed, Lightroom-style photo library/editor with a heavyweight Python processing/AI engine. The source is intentionally dependency-heavy because this build prioritizes feature coverage over cheap hosting.

## Deployment architecture

- **Node/Express**: catalog, storage, sharing, collaboration, imports, API orchestration and UI.
- **Python**: RAW/image processing, HDR/panorama and local AI/ML.
- **FFmpeg**: video and slideshow rendering.
- **ExifTool**: metadata import/export.
- **gPhoto2**: tethered camera capture.
- **Render persistent disk**: `/var/data` for originals, previews, catalog, exports and downloaded AI model weights.

The current `render.yaml` uses `runtime: docker`, and the `Dockerfile` installs the native dependencies plus the Python AI stack. Render's Blueprint specification supports Docker services and persistent `disk` mounts in the same service definition. See `FEATURES.md` for the detailed feature inventory.

## Deploy

1. Put this entire folder in a Git repository.
2. In Render, create/deploy the Blueprint from `render.yaml`, or configure an equivalent Docker web service.
3. Attach the paid persistent disk at `/var/data`.
4. Keep `DATA_DIR=/var/data`.
5. For AI model persistence, keep `HF_HOME=/var/data/models/huggingface` and `TORCH_HOME=/var/data/models/torch`.
6. Deploy. The first Docker build is intentionally large. The first invocation of several AI features will also download model weights to the persistent disk.

If you already have an existing Render service and disk, do not delete the disk contents. Make a backup/snapshot before changing the service configuration. Only paths under the mounted disk persist across deploys.

## Resource warning

The full local AI configuration can require many gigabytes of image layers/model weights and substantial RAM. SDXL inpainting in particular is GPU-oriented. The app is designed to fail with a visible tool error rather than pretend an AI operation succeeded. You can replace the default Hugging Face model IDs with smaller models using these environment variables:

- `LUMINA_SEGMENT_MODEL`
- `LUMINA_OBJECT_MODEL`
- `LUMINA_DEPTH_MODEL`
- `LUMINA_SR_MODEL`
- `LUMINA_INPAINT_MODEL`

## Development checks

```bash
npm install
python3 -m pip install -r engine/requirements.txt
npm run check
npm start
```

## Storage layout

`/var/data` contains `originals`, `previews`, `thumbs`, `renders`, `exports`, `ai`, `catalogs`, `galleries`, `slideshows`, `books`, `prints`, `videos`, `sidecars`, `published`, `plugins`, model caches, and `library.json`.

## Excluded by design

Generative Expand, AI Search, and image-to-video generation are not implemented anywhere in this repository.
