# Local Music Player

A browser music player for local development and static S3 + CloudFront deployment.

## Local backend mode

```bash
python3 server.py
```

Open:

```text
http://127.0.0.1:8765/music-player/
```

The Python server scans `/Users/xingdawang/Music/Converted Music` and exposes `/api/tracks`, `/api/media`, and `/api/artwork`.

## Static AWS mode

Build a static bundle:

```bash
npm run build:static
```

Generate `tracks.json` from the local music folder:

```bash
node scripts/generate-tracks-json.mjs "/Users/xingdawang/Music/Converted Music" \
  --prefix "./music/" \
  --output "dist/music-player-static-v0.1.0/tracks.json"
```

Deploy the files in `dist/music-player-static-v0.1.0/` and your music folder to S3, then serve them through CloudFront.

See [docs/aws-static-deploy.md](docs/aws-static-deploy.md) for the full deployment checklist.

## Convert music

```bash
python3 ncm_batch_convert.py
```
