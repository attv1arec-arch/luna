# Lumina Photo Studio — maximal Lightroom-style parity build

This build implements a large Lightroom/Lightroom Classic-style workflow with an original, open architecture. It does **not** contain Adobe source code, Adobe camera profiles, Adobe cloud services, or Adobe Firefly. Therefore "parity" here means functional equivalents and compatible workflows, not pixel-for-pixel equivalence with Adobe's proprietary algorithms.

The three product features intentionally excluded by request are **Generative Expand**, **AI Search**, and **Generate Video from an Image**.

## Implemented editing pipeline

- Non-destructive edit state per photo, undo/redo, reset, copyable JSON edit stack, named Versions, Virtual Copies, user Presets and XMP preset export.
- RAW decoding through LibRaw/rawpy for DNG/CR2/CR3/NEF/ARW/RAF/RW2/ORF and related formats where LibRaw supports the camera.
- Light: Exposure, Contrast, Highlights, Shadows, Whites, Blacks, automatic light/color analysis.
- Profiles: Color, Neutral, Vivid, Portrait, Landscape, Monochrome and Adaptive-style profile behavior, with profile amount.
- White balance: Temperature and Tint.
- Color: Vibrance, Saturation, B&W, eight-channel HSL/Color Mixer, Point Color adjustments.
- Curves: master RGB and per-channel R/G/B point curves; linear/medium/strong/matte presets.
- Color Grading: Shadows, Midtones, Highlights and Global hue/saturation/luminance plus Balance and Blending.
- Effects: Texture, Clarity, Dehaze, post-crop vignette controls and Grain controls.
- Detail: sharpening amount/radius/detail/masking plus luminance/color noise reduction controls.
- Optics: chromatic-aberration channel alignment, distortion correction, vignette/defringe controls, lens identity fields.
- Geometry: vertical/horizontal perspective, aspect, scale, X/Y offset, rotation and automatic line-based leveling/Upright approximation.
- Crop: free and standard ratios, rotation, straighten, mirror/flip, explicit normalized crop rectangle.
- Calibration-style shadow tint and RGB-primary hue/saturation adjustments.
- Server-side high-quality preview renders and full-resolution exports use the same Python image engine.

## Local adjustments and retouching

- Brush masks with painted points and adjustable brush size.
- Linear Gradient, Radial Gradient, Luminance Range and Color Range masks.
- Subject, Sky, Background, People, Object and Landscape AI selections using local segmentation models.
- Local mask Exposure, Contrast, Highlights, Shadows, Temperature, Tint, Saturation, Texture, Clarity, Dehaze, Sharpness and Noise controls.
- Invert masks and maintain multiple masks non-destructively.
- Heal, Clone and Content-Aware/Inpaint retouch operations.
- Manual Red Eye correction.
- Generative Remove with a local Diffusers inpainting pipeline.
- Distraction removal paths for people, reflections and sensor dust.
- Automatic blemish detection/retouch path.

## AI / ML — local heavyweight implementation

Model weights download into the persistent `HF_HOME`/`TORCH_HOME` model cache on first use.

- Subject, sky, background, object, people and landscape segmentation.
- Depth Anything depth estimation and depth-based Lens Blur output.
- Super Resolution through Swin2SR.
- Raw Details enhancement path using the super-resolution/detail reconstruction engine.
- Denoise processing and AI-enhancement copy workflow.
- AI Sharpen enhancement copy workflow.
- Stable Diffusion XL inpainting for Generative Remove.
- People-removal inpainting.
- Reflection-removal inpainting path.
- Sensor-dust detection and removal.
- Skin/blemish detection and cleanup.
- Assisted Culling with sharpness, exposure/clipping, face and eye analysis and Select/Review/Reject recommendations.
- Recommended Presets generated from image analysis.
- Adaptive Presets and Adaptive Profile equivalents.
- Auto Light & Color analysis.
- AI-generated enhanced copies are imported back into the library so the original remains untouched.

## Library / DAM

- Persistent originals, previews, thumbnails, renders, exports, AI outputs and sidecars on the Render disk.
- Grid, detail/editor view, filmstrip, zoom/fit, before/after, histogram.
- Multi-selection with Ctrl/Cmd-click.
- Albums and album folders API.
- Smart Albums with rule matching.
- Favorites, Pick/Reject, star ratings, color labels, keywords, title, caption, copyright, creator and location data model.
- EXIF metadata extraction via ExifTool including camera/lens/ISO/shutter/aperture/focal length/GPS where present.
- Filename/metadata/EXIF text search plus rating and sort filters.
- Stacks and auto-stack by capture-time interval.
- Soft delete/Trash, restore and automatic retention-based permanent deletion.
- Virtual Copies.
- XMP sidecar writing.
- Render-backed synchronization using server-sent events so connected browser sessions refresh when the catalog changes.
- PWA shell and cached thumbnails/previews for partial offline browsing.

## Import, catalog and storage

- Multi-file image and video import.
- JPEG/PNG/TIFF/WebP/AVIF/HEIF when platform codecs support it; RAW formats through LibRaw.
- Originals remain on the persistent disk; previews/thumbs are generated automatically.
- Catalog database stored as JSON for inspectability and portability.
- Catalog export to ZIP, optionally including originals and previews.
- Persistent model caches under the same Render disk.
- Smart-preview-equivalent preview files used for lightweight browsing/editing.

## HDR and panorama

- Multi-exposure HDR merge using OpenCV Debevec calibration/merge and Reinhard tone mapping.
- Panorama stitching using OpenCV feature matching/stitching.
- HDR Panorama pipeline: bracket groups -> HDR frames -> panorama stitch.

## Video

- Video import, thumbnails, duration/codec metadata and frame extraction.
- Start/end trimming.
- Exposure, Contrast, Saturation/Vibrance, Temperature/Tint, B&W, Vignette, Grain, clarity/dehaze-style sharpening, crop, rotate and flip translated into an FFmpeg render graph.
- H.264/AAC MP4 output.

## Export

- JPEG, PNG, WebP, AVIF and TIFF where installed codecs support the format.
- Quality and maximum-dimension resizing.
- DPI metadata.
- Output sharpening controls.
- Watermark text, opacity and position engine.
- Metadata copy-through via ExifTool, with optional GPS/location stripping.
- Content Credentials-style tamper-evident sidecar containing the SHA-256 hash and edit manifest.
- Batch export API.

## Lightroom Classic-style modules

- Catalogs and catalog ZIP export.
- Smart Collections/Smart Albums.
- Auto stacking by capture time.
- XMP sidecars and persistent edit history via Versions.
- GPX track import and capture-time geotag matching.
- Saved Locations data model.
- Tethered capture through `gphoto2` for supported cameras attached to the host.
- Photo Book PDF generation through ReportLab.
- Slideshow MP4 creation through FFmpeg.
- Contact-sheet/print-package PDF generation.
- Web gallery generation.
- Hard-drive Publish Service equivalent.
- External-editor handoff as a rendered full-resolution TIFF.
- Plug-in system using `/var/data/plugins/<plugin>/manifest.json` and executable filters; an example plug-in is included.

## Sharing, collaboration and learning equivalents

- Share an album with an unguessable public token/link.
- Optional original downloads.
- Optional contributor uploads.
- Optional collaborative editing endpoint.
- Comments and likes on shared albums.
- Local Discover feed: publish edits, like them and Remix the edit settings onto another photo.
- Built-in tutorial API for Light, Color and Masking workflows.

## Capture

- Browser camera capture into the persistent photo library.
- Front/rear camera switching when the browser/device exposes it.
- Server-connected tethered capture through gPhoto2.

## Things that cannot be literally identical to Adobe Lightroom

These are implementation/environment differences, not fake buttons:

- Adobe's proprietary Camera Raw demosaic algorithms, proprietary camera-matching profiles, proprietary lens profile database and exact Adobe color science are not distributable here. Lumina uses LibRaw/OpenCV/Pillow equivalents and user-configurable fields instead.
- Adobe Firefly/Sensei models are not included. Lumina uses open/local models for equivalent workflows.
- OS-level printer drivers, manufacturer camera SDKs and mobile manual-camera controls depend on the machine/device running the app. Lumina exposes PDF print output, gPhoto2 tethering and browser camera APIs instead.
- Photoshop itself is not embedded. Lumina provides a full-resolution TIFF external-editor roundtrip workflow and plug-in system.
- Adobe's global public Discover network and Adobe cloud identity/billing are not reproduced. Lumina provides a private deployment-scoped Discover/remix and sharing system.

## Intentionally excluded

- Generative Expand
- AI Search / semantic photo search
- Generate video from a still image
